"""Comprehensive V53 backtesting script"""
import sqlite3, json, sys, os, time, random
sys.path.insert(0, 'core')
from prediction_engine import process_prediction

DB_PATH = 'data/historical_archive.sqlite'
conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row

# Load May 2026 matches WITH odds (so we can compute ROI)
print('=== Loading May 2026 matches from archive_football_data ===')
rows = conn.execute("""
    SELECT * FROM archive_football_data 
    WHERE match_date >= '2026-05-01' AND match_date <= '2026-05-24'
    AND odds_home IS NOT NULL AND odds_away IS NOT NULL
    AND score_home IS NOT NULL AND score_away IS NOT NULL
    ORDER BY match_date
""").fetchall()
print(f'Found {len(rows)} matches')

# Also check how many matches from non-European leagues
total_train = conn.execute("SELECT COUNT(*) FROM archive_football_data").fetchone()[0]
print(f'Total training data available: {total_train}')

conn.close()

def build_match_obj(row):
    """Build a match_obj dict from a database row"""
    d = dict(row)
    return {
        'homeTeam': d['home_team'],
        'awayTeam': d['away_team'],
        'league': d.get('league_code', 'UNKNOWN'),
        'tournament_name': d.get('league_code', 'UNKNOWN'),
        'odds_home': float(d['odds_home']) if d['odds_home'] else 2.0,
        'odds_draw': float(d['odds_draw']) if d['odds_draw'] else 3.0,
        'odds_away': float(d['odds_away']) if d['odds_away'] else 3.0,
        'startTimestamp': 0,
        'force_predict': True,
    }

def actual_result(sh, sa):
    if sh > sa: return 'H'
    if sa > sh: return 'A'
    return 'D'

def implied_prob(odds):
    return 1.0 / odds if odds and odds > 0 else 0

def kelly_criterion(bet_prob, odds, bankroll=100, fraction=0.25):
    """Kelly stake as fraction of bankroll"""
    if odds <= 1 or bet_prob <= 0:
        return 0
    implied = 1.0 / odds
    edge = bet_prob - implied
    if edge <= 0:
        return 0
    kelly = edge / (odds - 1) * fraction
    return max(0, min(kelly, 0.1))  # cap at 10%

# Run predictions
results = []
errors = 0
skipped = 0

print(f'\n=== Running predictions on {len(rows)} matches ===')

# Use a smaller sample for speed if many matches
test_rows = rows  # Use all available

for i, row in enumerate(test_rows):
    if i > 0 and i % 50 == 0:
        print(f'  Progress: {i}/{len(test_rows)}...')

    d = dict(row)
    match_obj = build_match_obj(row)
    
    try:
        pred = process_prediction(match_obj)
        if not pred.get('success'):
            skipped += 1
            continue
        
        # Get predicted outcome (highest probability)
        probs = {
            'H': pred.get('home_win_probability', pred.get('xgboost_probs_h', 0)),
            'D': pred.get('draw_probability', pred.get('xgboost_probs_d', 0)),
            'A': pred.get('away_win_probability', pred.get('xgboost_probs_a', 0)),
        }
        predicted = max(probs, key=probs.get)
        confidence = max(probs.values())
        
        actual = actual_result(d['score_home'], d['score_away'])
        correct = (predicted == actual)
        
        # Odds for the predicted outcome
        odds_map = {'H': d['odds_home'], 'D': d['odds_draw'], 'A': d['odds_away']}
        pred_odds = odds_map.get(predicted, 2.0)
        
        # Value / Edge
        implied = implied_prob(pred_odds)
        edge = confidence - implied
        
        # Kelly stake
        kelly = kelly_criterion(confidence, pred_odds)
        
        results.append({
            'match': f"{d['home_team']} vs {d['away_team']}",
            'league': d['league_code'],
            'date': d.get('match_date', ''),
            'score': f"{d['score_home']}-{d['score_away']}",
            'predicted': predicted,
            'actual': actual,
            'correct': correct,
            'probs': probs,
            'confidence': confidence,
            'odds': pred_odds,
            'edge': edge,
            'kelly': kelly,
            'verdict': pred.get('verdict', ''),
        })
    except Exception as e:
        errors += 1

print(f'\nPredictions completed: {len(results)} successful, {errors} errors, {skipped} skipped')

if not results:
    print('No predictions to analyze!')
    sys.exit(1)

# ===== ANALYSIS =====
total = len(results)
correct_total = sum(1 for r in results if r['correct'])
accuracy = correct_total / total * 100

# By predicted outcome
h_pred = [r for r in results if r['predicted'] == 'H']
d_pred = [r for r in results if r['predicted'] == 'D']
a_pred = [r for r in results if r['predicted'] == 'A']

def acc_stats(group, name):
    if not group:
        return f'{name}: N=0'
    c = sum(1 for r in group if r['correct'])
    return f'{name}: {c}/{len(group)} = {c/len(group)*100:.1f}%'

print(f'\n{"="*60}')
print(f'PART 1: ACCURACY (Backtesting)')
print(f'{"="*60}')
print(f'Overall accuracy: {correct_total}/{total} = {accuracy:.2f}%')
print(f'  {acc_stats(h_pred, "Home picks")}')
print(f'  {acc_stats(d_pred, "Draw picks")}')
print(f'  {acc_stats(a_pred, "Away picks")}')

# Accuracy by confidence bracket
print(f'\nAccuracy by confidence bracket:')
brackets = [(0, 60), (60, 70), (70, 80), (80, 90), (90, 100)]
for lo, hi in brackets:
    group = [r for r in results if lo <= r['confidence']*100 < hi]
    if group:
        c = sum(1 for r in group if r['correct'])
        print(f'  {lo}-{hi}%: {c}/{len(group)} = {c/len(group)*100:.1f}% (N={len(group)})')

# Accuracy by verdict
print(f'\nAccuracy by verdict:')
verdicts = set(r['verdict'] for r in results)
for v in sorted(verdicts):
    group = [r for r in results if r['verdict'] == v]
    if group:
        c = sum(1 for r in group if r['correct'])
        print(f'  {v}: {c}/{len(group)} = {c/len(group)*100:.1f}% (N={len(group)})')

# ===== ROI ANALYSIS =====
print(f'\n{"="*60}')
print(f'PART 2: ROI ANALYSIS (Simulated Betting)')
print(f'{"="*60}')

# Strategy 1: Bet every match, equal stake
stake_per_bet = 1.0
total_stake = total * stake_per_bet
total_return = 0
for r in results:
    if r['correct']:
        total_return += r['odds'] * stake_per_bet
roi_simple = (total_return - total_stake) / total_stake * 100

print(f'Strategy 1: Flat bet on every match (1 unit each)')
print(f'  Bets: {total}, Stake: {total_stake:.0f}u, Return: {total_return:.1f}u')
print(f'  ROI: {roi_simple:+.2f}%')

# Strategy 2: Kelly criterion
kelly_stake = 0
kelly_return = 0
kelly_bets = 0
for r in results:
    if r['kelly'] > 0.01:  # Only bet when Kelly suggests >1%
        kelly_bets += 1
        bet = r['kelly']
        kelly_stake += bet
        if r['correct']:
            kelly_return += bet * r['odds']

roi_kelly = (kelly_return - kelly_stake) / kelly_stake * 100 if kelly_stake > 0 else 0
print(f'\nStrategy 2: Kelly Criterion (25% fractional)')
print(f'  Bets: {kelly_bets}, Stake: {kelly_stake:.2f}u, Return: {kelly_return:.2f}u')
print(f'  ROI: {roi_kelly:+.2f}%')

# Strategy 3: Only SAFE BET / STRONG BET verdicts
safe_results = [r for r in results if r['verdict'] in ('SAFE BET', 'STRONG BET', 'SURGICAL STRIKE')]
safe_correct = sum(1 for r in safe_results if r['correct'])
safe_acc = safe_correct / len(safe_results) * 100 if safe_results else 0
safe_stake = len(safe_results)
safe_return = sum(r['odds'] for r in safe_results if r['correct'])
safe_roi = (safe_return - safe_stake) / safe_stake * 100 if safe_stake > 0 else 0
print(f'\nStrategy 3: Only SAFE/STRONG verdicts')
print(f'  Bets: {len(safe_results)}, Correct: {safe_correct}/{len(safe_results)} = {safe_acc:.1f}%')
print(f'  ROI: {safe_roi:+.2f}%')

# Strategy 4: Edge betting (only when edge > 5%)
edge_results = [r for r in results if r['edge'] > 0.05]
edge_correct = sum(1 for r in edge_results if r['correct'])
edge_acc = edge_correct / len(edge_results) * 100 if edge_results else 0
edge_stake = len(edge_results)
edge_return = sum(r['odds'] for r in edge_results if r['correct'])
edge_roi = (edge_return - edge_stake) / edge_stake * 100 if edge_stake > 0 else 0
print(f'\nStrategy 4: Value betting (edge > 5%)')
print(f'  Bets: {len(edge_results)}, Correct: {edge_correct}/{len(edge_results)} = {edge_acc:.1f}%')
print(f'  ROI: {edge_roi:+.2f}%')

# ===== BIAS CHECK =====
print(f'\n{"="*60}')
print(f'PART 3: BIAS CHECK')
print(f'{"="*60}')

home_bias = len(h_pred) / total * 100
draw_bias = len(d_pred) / total * 100
away_bias = len(a_pred) / total * 100
actual_h = sum(1 for r in results if r['actual'] == 'H') / total * 100
actual_d = sum(1 for r in results if r['actual'] == 'D') / total * 100
actual_a = sum(1 for r in results if r['actual'] == 'A') / total * 100

print(f'Distribution of predictions:')
print(f'  Home: {home_bias:.1f}% (actual: {actual_h:.1f}%)')
print(f'  Draw: {draw_bias:.1f}% (actual: {actual_d:.1f}%)')
print(f'  Away: {away_bias:.1f}% (actual: {actual_a:.1f}%)')

# Log loss
import math
log_loss_total = 0
for r in results:
    prob = r['probs'].get(r['actual'], 0.001)
    prob = max(0.001, min(0.999, prob))
    log_loss_total += -math.log2(prob)
avg_log_loss = log_loss_total / total
print(f'\nLog Loss (lower is better): {avg_log_loss:.4f}')
print(f'  Random guess would be ~1.585 (log2(3))')
print(f'  Perfect would be 0')

# Confidence calibration
print(f'\nConfidence Calibration:')
for bracket_name, lo, hi in [('Low (0-60%)', 0, 0.6), ('Medium (60-75%)', 0.6, 0.75), ('High (75-90%)', 0.75, 0.9), ('Elite (90-100%)', 0.9, 1.0)]:
    group = [r for r in results if lo <= r['confidence'] < hi]
    if group:
        actual_rate = sum(1 for r in group if r['correct']) / len(group)
        avg_conf = sum(r['confidence'] for r in group) / len(group)
        print(f'  {bracket_name}: avg_conf={avg_conf*100:.1f}%, actual={actual_rate*100:.1f}% (N={len(group)})')

# ===== COMPARISON =====
print(f'\n{"="*60}')
print(f'PART 4: COMPARISON WITH OLDER VERSIONS')
print(f'{"="*60}')

# These are known values from previous benchmarks
print(f'V53 (this test)   : Accuracy = {accuracy:.2f}%, ROI(flat) = {roi_simple:+.2f}%, LogLoss = {avg_log_loss:.4f}')
print(f'V24 (previous)    : Accuracy = ~48.72% (training), unknown backtest')
print(f'V23 (older)       : Accuracy = ~46-47% (estimated)')
print(f'\nImprovement V53 vs V24 training: +{accuracy - 48.72:.2f}% accuracy')

# ===== FINAL VERDICT =====
print(f'\n{"="*60}')
print(f'FINAL VERDICT')
print(f'{"="*60}')

# Check if system passes thresholds
pass_accuracy = accuracy > 50
pass_roi = roi_simple > 0 or edge_roi > 0
pass_bias = abs(home_bias - 50) < 30  # Not excessively home-biased
pass_calibration = True

print(f'Accuracy > 50%? {"✅ YES" if pass_accuracy else "❌ NO"}: {accuracy:.2f}%')
print(f'Positive ROI?   {"✅ YES" if pass_roi else "❌ NO"}: flat={roi_simple:+.2f}%, edge={edge_roi:+.2f}%')
print(f'Bias OK?        {"✅ YES" if pass_bias else "❌ NO"}: Home picks {home_bias:.1f}%')

ready = pass_accuracy and (pass_roi or edge_roi > 0)
if ready:
    print(f'\n✅ SYSTEM IS READY FOR LIVE MATCHES')
    print(f'   The V53 model shows {accuracy:.1f}% accuracy with {roi_simple:+.1f}% ROI')
else:
    print(f'\n⚠️  SYSTEM NEEDS IMPROVEMENT')
    print(f'   Key areas to address:')
    if not pass_accuracy:
        print(f'   - Accuracy below 50% threshold')
    if not pass_roi:
        print(f'   - ROI is negative or flat')

print(f'\n=== Backtest completed on {total} matches ===')
