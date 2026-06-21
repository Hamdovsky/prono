"""Final V53 backtest with proper team form features from archive DB"""
import sqlite3, json, sys, os, time, math
sys.path.insert(0, 'core')
from prediction_engine import process_prediction

DB_PATH = 'data/historical_archive.sqlite'
conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row

# Load May 2026 matches WITH odds
rows = conn.execute("""
    SELECT * FROM archive_football_data 
    WHERE match_date >= '2026-05-01' AND match_date <= '2026-05-24'
    AND odds_home IS NOT NULL AND odds_away IS NOT NULL
    AND odds_draw IS NOT NULL
    AND score_home IS NOT NULL AND score_away IS NOT NULL
    ORDER BY match_date
""").fetchall()
print(f'Found {len(rows)} matches')

def get_team_form(team_name, before_date, limit=5):
    """Get recent form for a team from archive data"""
    rows_f = conn.execute("""
        SELECT home_team, away_team, score_home, score_away, match_date
        FROM archive_football_data
        WHERE (home_team = ? OR away_team = ?)
        AND match_date < ?
        AND score_home IS NOT NULL AND score_away IS NOT NULL
        ORDER BY match_date DESC
        LIMIT ?
    """, (team_name, team_name, before_date, limit)).fetchall()
    
    form = []
    for r in rows_f:
        if r['home_team'] == team_name:
            gf, ga = r['score_home'], r['score_away']
            if gf > ga: result = 'W'
            elif gf < ga: result = 'L'
            else: result = 'D'
        else:
            gf, ga = r['score_away'], r['score_home']
            if gf > ga: result = 'W'
            elif gf < ga: result = 'L'
            else: result = 'D'
        form.append({'goals_for': gf, 'goals_against': ga, 'result': result})
    return form

def get_team_avg_stats(team_name, before_date):
    """Get average goals scored/conceded for a team"""
    rows_f = conn.execute("""
        SELECT home_team, away_team, score_home, score_away
        FROM archive_football_data
        WHERE (home_team = ? OR away_team = ?)
        AND match_date < ?
        AND score_home IS NOT NULL AND score_away IS NOT NULL
        ORDER BY match_date DESC
        LIMIT 20
    """, (team_name, team_name, before_date)).fetchall()
    
    total_gf, total_ga, cnt = 0, 0, 0
    for r in rows_f:
        cnt += 1
        if r['home_team'] == team_name:
            total_gf += r['score_home']
            total_ga += r['score_away']
        else:
            total_gf += r['score_away']
            total_ga += r['score_home']
    if cnt == 0:
        return 1.2, 1.2
    return total_gf/cnt, total_ga/cnt

def build_match_obj(row):
    """Build match_obj with derived form features"""
    d = dict(row)
    before_date = d.get('match_date', '2026-05-01')
    
    h_form_raw = get_team_form(d['home_team'], before_date)
    a_form_raw = get_team_form(d['away_team'], before_date)
    
    h_avg_gf, h_avg_ga = get_team_avg_stats(d['home_team'], before_date)
    a_avg_gf, a_avg_ga = get_team_avg_stats(d['away_team'], before_date)
    
    form_ctx = {
        'home': {
            'standing': {'position': 10, 'total_teams': 20},
            'form': [r['result'] for r in h_form_raw],
            'goals_for': sum(r['goals_for'] for r in h_form_raw) / max(len(h_form_raw), 1),
            'goals_against': sum(r['goals_against'] for r in h_form_raw) / max(len(h_form_raw), 1),
        },
        'away': {
            'standing': {'position': 10, 'total_teams': 20},
            'form': [r['result'] for r in a_form_raw],
            'goals_for': sum(r['goals_for'] for r in a_form_raw) / max(len(a_form_raw), 1),
            'goals_against': sum(r['goals_against'] for r in a_form_raw) / max(len(a_form_raw), 1),
        }
    }
    
    home_xg = (h_avg_gf + a_avg_ga) / 2.0
    away_xg = (a_avg_gf + h_avg_ga) / 2.0
    
    return {
        'homeTeam': d['home_team'],
        'awayTeam': d['away_team'],
        'league': d.get('league_code', 'UNKNOWN'),
        'tournament_name': d.get('league_code', 'UNKNOWN'),
        'odds_home': float(d['odds_home']),
        'odds_draw': float(d['odds_draw']),
        'odds_away': float(d['odds_away']),
        'home_xg': home_xg,
        'away_xg': away_xg,
        'form_context': form_ctx,
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
    if odds <= 1 or bet_prob <= 0: return 0
    implied = 1.0 / odds
    edge = bet_prob - implied
    if edge <= 0: return 0
    kelly = edge / (odds - 1) * fraction
    return max(0, min(kelly, 0.1))

# Run predictions
results = []
errors = 0
skipped = 0

print(f'\nRunning predictions on {len(rows)} matches...')
for i, row in enumerate(rows):
    if i > 0 and i % 50 == 0:
        print(f'  Progress: {i}/{len(rows)}...')

    d = dict(row)
    match_obj = build_match_obj(row)
    
    try:
        pred = process_prediction(match_obj)
        if not pred.get('success'):
            skipped += 1
            continue
        
        probs = {
            'H': pred.get('home_win_probability', pred.get('xgboost_probs_h', 0)),
            'D': pred.get('draw_probability', pred.get('xgboost_probs_d', 0)),
            'A': pred.get('away_win_probability', pred.get('xgboost_probs_a', 0)),
        }
        predicted = max(probs, key=probs.get)
        confidence = max(probs.values())
        
        actual = actual_result(d['score_home'], d['score_away'])
        correct = (predicted == actual)
        
        odds_map = {'H': d['odds_home'], 'D': d['odds_draw'], 'A': d['odds_away']}
        pred_odds = odds_map.get(predicted, 2.0)
        
        implied = implied_prob(pred_odds)
        edge = confidence - implied
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

print(f'\nPredictions: {len(results)} ok, {errors} errors, {skipped} skipped')
if not results:
    print('No predictions!')
    sys.exit(1)

# ===== ANALYSIS =====
total = len(results)
correct_total = sum(1 for r in results if r['correct'])
accuracy = correct_total / total * 100

h_pred = [r for r in results if r['predicted'] == 'H']
d_pred = [r for r in results if r['predicted'] == 'D']
a_pred = [r for r in results if r['predicted'] == 'A']

def acc_stats(group, name):
    if not group: return f'{name}: N=0'
    c = sum(1 for r in group if r['correct'])
    return f'{name}: {c}/{len(group)} = {c/len(group)*100:.1f}%'

print(f'\n{"="*60}')
print(f'PART 1: ACCURACY')
print(f'{"="*60}')
print(f'Overall: {correct_total}/{total} = {accuracy:.2f}%')
print(f'  {acc_stats(h_pred, "Home picks")}')
print(f'  {acc_stats(d_pred, "Draw picks")}')
print(f'  {acc_stats(a_pred, "Away picks")}')

# Accuracy by confidence bracket
print(f'\nAccuracy by confidence:')
for lo, hi in [(0, 60), (60, 70), (70, 80), (80, 90), (90, 100)]:
    group = [r for r in results if lo <= r['confidence']*100 < hi]
    if group:
        c = sum(1 for r in group if r['correct'])
        print(f'  {lo}-{hi}%: {c}/{len(group)} = {c/len(group)*100:.1f}% (N={len(group)})')

# ===== ROI =====
print(f'\n{"="*60}')
print(f'PART 2: ROI')
print(f'{"="*60}')

# Strategy 1: Flat bet every match
total_stake = total * 1.0
total_return = sum(r['odds'] for r in results if r['correct'])
roi_flat = (total_return - total_stake) / total_stake * 100
print(f'Flat bet (1u each): {total_stake:.0f}u staked, {total_return:.1f}u returned')
print(f'  ROI: {roi_flat:+.2f}%')

# Strategy 2: Kelly
kelly_stake = 0
kelly_return = 0
kelly_bets = 0
for r in results:
    if r['kelly'] > 0.01:
        kelly_bets += 1
        kelly_stake += r['kelly']
        if r['correct']:
            kelly_return += r['kelly'] * r['odds']
roi_kelly = ((kelly_return - kelly_stake) / kelly_stake * 100) if kelly_stake > 0 else 0
print(f'Kelly (25% frac): {kelly_bets} bets, {kelly_stake:.2f}u staked, {kelly_return:.2f}u returned')
print(f'  ROI: {roi_kelly:+.2f}%')

# Strategy 3: Safe/Strong verdicts
safe = [r for r in results if r['verdict'] in ('SAFE BET', 'STRONG BET', 'SURGICAL STRIKE')]
if safe:
    sc = sum(1 for r in safe if r['correct'])
    sa = sum(r['odds'] for r in safe if r['correct'])
    sr = len(safe)
    print(f'Safe/Strong verdicts: {sc}/{len(safe)} = {sc/len(safe)*100:.1f}% ROI={(sa-sr)/sr*100:+.2f}%')

# Strategy 4: Value edge >5%
edge_bets = [r for r in results if r['edge'] > 0.05]
if edge_bets:
    ec = sum(1 for r in edge_bets if r['correct'])
    er = len(edge_bets)
    ereturn = sum(r['odds'] for r in edge_bets if r['correct'])
    print(f'Edge >5%: {ec}/{er} = {ec/er*100:.1f}% ROI={(ereturn-er)/er*100:+.2f}%')

# ===== BIAS CHECK =====
print(f'\n{"="*60}')
print(f'PART 3: BIAS')
print(f'{"="*60}')
home_bias = len(h_pred) / total * 100
draw_bias = len(d_pred) / total * 100
away_bias = len(a_pred) / total * 100
actual_h = sum(1 for r in results if r['actual'] == 'H') / total * 100
actual_d = sum(1 for r in results if r['actual'] == 'D') / total * 100
actual_a = sum(1 for r in results if r['actual'] == 'A') / total * 100
print(f'Predicted: H={home_bias:.1f}% D={draw_bias:.1f}% A={away_bias:.1f}%')
print(f'Actual:    H={actual_h:.1f}% D={actual_d:.1f}% A={actual_a:.1f}%')

# Log loss
log_loss_total = 0
for r in results:
    prob = r['probs'].get(r['actual'], 0.001)
    prob = max(0.001, min(0.999, prob))
    log_loss_total += -math.log2(prob)
avg_log_loss = log_loss_total / total
print(f'\nLog Loss: {avg_log_loss:.4f} (random=1.585, perfect=0)')

# Calibration
print(f'\nCalibration:')
for bracket_name, lo, hi in [('Low 0-60%', 0, 0.6), ('Med 60-75%', 0.6, 0.75), ('High 75-90%', 0.75, 0.9), ('Elite 90-100%', 0.9, 1.0)]:
    group = [r for r in results if lo <= r['confidence'] < hi]
    if group:
        actual_rate = sum(1 for r in group if r['correct']) / len(group)
        avg_conf = sum(r['confidence'] for r in group) / len(group)
        print(f'  {bracket_name}: conf={avg_conf*100:.1f}% actual={actual_rate*100:.1f}% (N={len(group)})')

print(f'\n{"="*60}')
print(f'FINAL VERDICT')
print(f'{"="*60}')
pass_acc = accuracy > 50
pass_roi = roi_flat > 0 or roi_kelly > 0
pass_bias = len(h_pred) < total * 0.90  # not >90% home picks
print(f'Accuracy >50%? {"YES" if pass_acc else "NO"}: {accuracy:.2f}%')
print(f'Positive ROI? {"YES" if pass_roi else "NO"}: flat={roi_flat:+.2f}% kelly={roi_kelly:+.2f}%')
print(f'Bias OK?     {"YES" if pass_bias else "NO"}: Home picks {home_bias:.1f}%')
if pass_acc and pass_roi:
    print(f'\nREADY FOR LIVE MATCHES')
else:
    print(f'\nNEEDS IMPROVEMENT')

print(f'\nCompleted on {total} matches')
conn.close()
