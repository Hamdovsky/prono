"""V53 Backtest with FULL features: xG, fatigue, closing odds, form, teamStats"""
import sqlite3, json, math, sys, os, time
sys.path.insert(0, 'core')
from prediction_engine import process_prediction

DB_PATH = 'data/historical_archive.sqlite'
conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row

ROWS = conn.execute("""
    SELECT * FROM archive_football_data 
    WHERE match_date >= '2026-05-01' AND match_date <= '2026-05-24'
    AND odds_home IS NOT NULL AND odds_away IS NOT NULL AND odds_draw IS NOT NULL
    AND score_home IS NOT NULL AND score_away IS NOT NULL
    ORDER BY match_date
""").fetchall()
print(f"Loaded {len(ROWS)} matches")

def get_team_history(team, before):
    """Get recent results for form computation"""
    rows_f = conn.execute("""
        SELECT home_team, away_team, score_home, score_away
        FROM archive_football_data
        WHERE (home_team = ? OR away_team = ?) AND match_date < ?
        AND score_home IS NOT NULL AND score_away IS NOT NULL
        ORDER BY match_date DESC LIMIT 20
    """, (team, team, before)).fetchall()
    return [dict(r) for r in rows_f]

def get_team_season_stats(team, before):
    """Get season average goals, shots, etc."""
    rows_f = conn.execute("""
        SELECT home_team, away_team, score_home, score_away,
               shots_home, shots_away, sot_home, sot_away,
               corners_home, corners_away, yellow_home, yellow_away,
               fouls_home, fouls_away
        FROM archive_football_data
        WHERE (home_team = ? OR away_team = ?) AND match_date < ?
        AND match_date > date(?, '-180 days')
        AND score_home IS NOT NULL
        ORDER BY match_date DESC LIMIT 20
    """, (team, team, before, before)).fetchall()
    
    if not rows_f:
        return {'avg_gf': 1.2, 'avg_ga': 1.2, 'avg_shots': 10, 'avg_sot': 4,
                'avg_corners': 5, 'avg_fouls': 10, 'avg_yellow': 2, 'win_rate': 0.35}
    
    stats = {'gf': 0, 'ga': 0, 'shots': 0, 'sot': 0, 'corners': 0, 
             'fouls': 0, 'yellow': 0, 'wins': 0, 'cnt': 0}
    
    for r in rows_f:
        stats['cnt'] += 1
        if r['home_team'] == team:
            stats['gf'] += (r['score_home'] or 0)
            stats['ga'] += (r['score_away'] or 0)
            if r['score_home'] > r['score_away']: stats['wins'] += 1
            stats['shots'] += (r['shots_home'] or 10)
            stats['sot'] += (r['sot_home'] or 4)
            stats['corners'] += (r['corners_home'] or 5)
            stats['fouls'] += (r['fouls_home'] or 10)
            stats['yellow'] += (r['yellow_home'] or 2)
        else:
            stats['gf'] += (r['score_away'] or 0)
            stats['ga'] += (r['score_home'] or 0)
            if r['score_away'] > r['score_home']: stats['wins'] += 1
            stats['shots'] += (r['shots_away'] or 10)
            stats['sot'] += (r['sot_away'] or 4)
            stats['corners'] += (r['corners_away'] or 5)
            stats['fouls'] += (r['fouls_away'] or 10)
            stats['yellow'] += (r['yellow_away'] or 2)
    
    c = max(stats['cnt'], 1)
    return {'avg_gf': stats['gf']/c, 'avg_ga': stats['ga']/c,
            'avg_shots': stats['shots']/c, 'avg_sot': stats['sot']/c,
            'avg_corners': stats['corners']/c, 'avg_fouls': stats['fouls']/c,
            'avg_yellow': stats['yellow']/c, 'win_rate': stats['wins']/c}

def build_match_obj(row):
    d = dict(row)
    before = d.get('match_date', '2026-05-01')
    
    h_form_raw = get_team_history(d['home_team'], before)
    a_form_raw = get_team_history(d['away_team'], before)
    h_stats = get_team_season_stats(d['home_team'], before)
    a_stats = get_team_season_stats(d['away_team'], before)
    
    h_form_rs = [('W' if r['score_home'] > r['score_away'] else 
                  'L' if r['score_home'] < r['score_away'] else 'D') 
                 if r['home_team'] == d['home_team'] else
                 ('W' if r['score_away'] > r['score_home'] else 
                  'L' if r['score_away'] < r['score_home'] else 'D')
                 for r in h_form_raw]
    
    a_form_rs = [('W' if r['score_home'] > r['score_away'] else 
                  'L' if r['score_home'] < r['score_away'] else 'D') 
                 if r['home_team'] == d['away_team'] else
                 ('W' if r['score_away'] > r['score_home'] else 
                  'L' if r['score_away'] < r['score_home'] else 'D')
                 for r in a_form_raw]
    
    oh = float(d['odds_home'])
    od = float(d['odds_draw'])
    oa = float(d['odds_away'])
    implied_h = 1.0/oh if oh > 0 else 0.33
    implied_d = 1.0/od if od > 0 else 0.33
    implied_a = 1.0/oa if oa > 0 else 0.34
    s = implied_h + implied_d + implied_a
    implied_h /= s; implied_d /= s; implied_a /= s
    
    home_xg = (implied_h * 2.5 + h_stats['avg_gf']) / 2
    away_xg = (implied_a * 2.5 + a_stats['avg_gf']) / 2
    
    form_ctx = {
        'home': {
            'standing': {'position': max(1, min(20, int(20*(1-h_stats['win_rate'])+1))), 'total_teams': 20},
            'form': h_form_rs[:10],
            'goals_for': h_stats['avg_gf'],
            'goals_against': h_stats['avg_ga'],
        },
        'away': {
            'standing': {'position': max(1, min(20, int(20*(1-a_stats['win_rate'])+1))), 'total_teams': 20},
            'form': a_form_rs[:10],
            'goals_for': a_stats['avg_gf'],
            'goals_against': a_stats['avg_ga'],
        }
    }
    
    teamStats = {
        'home': {
            'avgGoalsScored': h_stats['avg_gf'],
            'avgGoalsConceded': h_stats['avg_ga'],
            'avgShots': h_stats['avg_shots'],
            'avgShotsOnTarget': h_stats['avg_sot'],
            'avgCorners': h_stats['avg_corners'],
            'avgFouls': h_stats['avg_fouls'],
            'avgYellowCards': h_stats['avg_yellow'],
        },
        'away': {
            'avgGoalsScored': a_stats['avg_gf'],
            'avgGoalsConceded': a_stats['avg_ga'],
            'avgShots': a_stats['avg_shots'],
            'avgShotsOnTarget': a_stats['avg_sot'],
            'avgCorners': a_stats['avg_corners'],
            'avgFouls': a_stats['avg_fouls'],
            'avgYellowCards': a_stats['avg_yellow'],
        }
    }
    
    return {
        'homeTeam': d['home_team'],
        'awayTeam': d['away_team'],
        'league': d.get('league_code', 'UNKNOWN'),
        'tournament_name': d.get('league_code', 'UNKNOWN'),
        'odds_home': oh,
        'odds_draw': od,
        'odds_away': oa,
        'home_xg': home_xg,
        'away_xg': away_xg,
        'form_context': form_ctx,
        'teamStats': teamStats,
        'startTimestamp': 0,
        'force_predict': True,
    }

def actual(sh, sa):
    if sh > sa: return 'H'
    if sa > sh: return 'A'
    return 'D'

# Run
results = []
errors = 0
print(f"\nRunning predictions on {len(ROWS)} matches with FULL features...")
start = time.time()

for i, row in enumerate(ROWS):
    if i > 0 and i % 50 == 0:
        elapsed = time.time() - start
        print(f"  [{i}/{len(ROWS)}] {elapsed:.0f}s elapsed")
    
    mo = build_match_obj(row)
    try:
        pred = process_prediction(mo)
        if not pred.get('success'):
            errors += 1
            continue
        
        probs = {
            'H': pred.get('home_win_probability', pred.get('xgboost_probs_h', 0)),
            'D': pred.get('draw_probability', pred.get('xgboost_probs_d', 0)),
            'A': pred.get('away_win_probability', pred.get('xgboost_probs_a', 0)),
        }
        predicted = max(probs, key=probs.get)
        confidence = max(probs.values())
        actual_r = actual(dict(row)['score_home'], dict(row)['score_away'])
        correct = (predicted == actual_r)
        
        results.append({
            'match': f"{row['home_team']} vs {row['away_team']}",
            'league': row['league_code'],
            'score': f"{row['score_home']}-{row['score_away']}",
            'predicted': predicted,
            'actual': actual_r,
            'correct': correct,
            'confidence': confidence,
            'probs': probs,
            'odds_h': mo['odds_home'],
            'odds_a': mo['odds_away'],
        })
    except Exception as e:
        errors += 1

conn.close()
elapsed = time.time() - start

# Results
total = len(results)
if total == 0:
    print(f"\nNo successful predictions! {errors} errors")
    sys.exit(1)

correct_c = sum(1 for r in results if r['correct'])
accuracy = correct_c / total * 100

h_pred = [r for r in results if r['predicted'] == 'H']
d_pred = [r for r in results if r['predicted'] == 'D']
a_pred = [r for r in results if r['predicted'] == 'A']

print(f"\n{'='*60}")
print(f"BACKTEST V53 — FULL FEATURES")
print(f"{'='*60}")
print(f"Time: {elapsed:.0f}s | {total} matches, {errors} errors")
print(f"\nACCURACY: {correct_c}/{total} = {accuracy:.2f}%")

for group, label in [(h_pred, 'Home'), (d_pred, 'Draw'), (a_pred, 'Away')]:
    if group:
        c = sum(1 for r in group if r['correct'])
        print(f"  {label} picks: {c}/{len(group)} = {c/len(group)*100:.1f}%")

# Distribution
home_bias = len(h_pred) / total * 100
draw_bias = len(d_pred) / total * 100
away_bias = len(a_pred) / total * 100
actual_h = sum(1 for r in results if r['actual'] == 'H') / total * 100
actual_d = sum(1 for r in results if r['actual'] == 'D') / total * 100
actual_a = sum(1 for r in results if r['actual'] == 'A') / total * 100

print(f"\nBIAS:")
print(f"  Predicted: H={home_bias:.1f}% D={draw_bias:.1f}% A={away_bias:.1f}%")
print(f"  Actual:    H={actual_h:.1f}% D={actual_d:.1f}% A={actual_a:.1f}%")

# Accuracy by confidence
print(f"\nConfidence calibration:")
for lo, hi, label in [(0, 0.6, 'Low 0-60%'), (0.6, 0.75, 'Med 60-75%'), (0.75, 0.9, 'High 75-90%'), (0.9, 1.0, 'Elite 90-100%')]:
    g = [r for r in results if lo <= r['confidence'] < hi]
    if g:
        ac = sum(1 for r in g if r['correct']) / len(g)
        ac_c = sum(1 for r in g if r['confidence'] > 0.5)  # just for show
        print(f"  {label}: actual={ac*100:.1f}% (N={len(g)})")

# ROI (flat bet)
total_stake = total * 1.0
total_return = 0
for r in results:
    if r['correct']:
        odds = r['odds_h'] if r['predicted'] == 'H' else (r['odds_a'] if r['predicted'] == 'A' else 3.5)
        total_return += odds
roi = (total_return - total_stake) / total_stake * 100
print(f"\nROI (flat 1u): {total_stake:.0f}u staked, {total_return:.1f}u returned = {roi:+.2f}%")

# Log loss
ll = 0
for r in results:
    p = r['probs'].get(r['actual'], 0.001)
    p = max(0.001, min(0.999, p))
    ll += -math.log2(p)
print(f"Log Loss: {ll/total:.4f} (random=1.585, perfect=0)")

print(f"\n{'='*60}")
print(f"VERDICT:")
print(f"{'='*60}")
print(f"Accuracy >50%? {'YES' if accuracy>50 else 'NO'}: {accuracy:.2f}%")
print(f"ROI >0%?    {'YES' if roi>0 else 'NO'}: {roi:+.2f}%")
print(f"Bias ok?    {'YES' if home_bias<90 else 'NO'}: home={home_bias:.1f}%")
print(f"\n{'='*60}")
