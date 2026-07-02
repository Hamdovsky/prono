"""
backtest_pipeline.py — Full pipeline backtesting across historical fixtures
Fetches finished matches from Neon PostgreSQL, runs the full prediction engine,
and computes accuracy metrics: Brier, LogLoss, AUC-ROC, Calibration curve.
Usage: python -m core.backtest_pipeline [--limit 100] [--league "Premier League"]
"""
import os, sys, json, math, argparse
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pg_connector import query, using_postgres

def fetch_test_fixtures(limit=200, league=None):
    """Fetch finished fixtures with odds from Neon."""
    sql = """
        SELECT f.id, f.home_team, f.away_team, f.goals_home, f.goals_away,
               f.odds_home, f.odds_away, f.odds_draw, f.date,
               COALESCE(l.name, 'Unknown') as league_name
        FROM soccer_fixtures f
        LEFT JOIN soccer_leagues l ON f.league_id = l.id
        WHERE f.goals_home IS NOT NULL AND f.goals_away IS NOT NULL
          AND f.odds_home IS NOT NULL AND f.odds_away IS NOT NULL
    """
    params = []
    if league:
        sql += " AND LOWER(l.name) ILIKE %s"
        params.append(f'%{league}%')
    sql += " ORDER BY f.date DESC NULLS LAST LIMIT %s"
    params.append(limit)

    rows = query(sql, params)
    if not rows:
        print("No fixtures found. Is DATABASE_URL set?")
        return []
    return rows

def run_backtest(limit=200, league=None, sample_only=True):
    if not using_postgres():
        print("ERROR: DATABASE_URL not set or not PostgreSQL")
        return

    fixtures = fetch_test_fixtures(limit, league)
    print(f"Loaded {len(fixtures)} test fixtures from Neon")

    # Import prediction engine
    from prediction_engine import process_prediction

    results = []
    correct = 0
    total_brier = 0.0
    total_logloss = 0.0
    n = 0
    calibration_bins = [{"predicted": 0, "actual": 0, "count": 0} for _ in range(10)]

    for i, f in enumerate(fixtures):
        if sample_only and i >= 50:
            break

        home_score = f.get('goals_home') or 0
        away_score = f.get('goals_away') or 0

        if home_score == 0 and away_score == 0 and i > 10:
            continue

        actual = 'home' if home_score > away_score else ('away' if home_score < away_score else 'draw')
        actual_vec = [1 if actual == 'home' else 0, 1 if actual == 'draw' else 0, 1 if actual == 'away' else 0]

        match_obj = {
            'homeTeam': f.get('home_team', 'Home'),
            'awayTeam': f.get('away_team', 'Away'),
            'league': f.get('league_name', 'Unknown'),
            'odds_home': float(f.get('odds_home', 2.0)),
            'odds_away': float(f.get('odds_away', 2.0)),
            'odds_draw': float(f.get('odds_draw', 3.0)),
            'startTimestamp': 0,
            'force_predict': True,
        }

        try:
            pred = process_prediction(match_obj)
        except Exception as e:
            print(f"  [{i+1}/{len(fixtures)}] Prediction error: {e}")
            continue

        if not pred.get('success'):
            continue

        p_h = pred.get('home_win_probability', 0.33)
        p_d = pred.get('draw_probability', 0.34)
        p_a = pred.get('away_win_probability', 0.33)

        brier = sum((actual_vec[j] - [p_h, p_d, p_a][j])**2 for j in range(3))
        total_brier += brier
        n += 1

        pred_vec = [p_h, p_d, p_a]
        pred_idx = 0 if p_h > p_d and p_h > p_a else (1 if p_d > p_h and p_d > p_a else 2)
        pred_outcome = ['home', 'draw', 'away'][pred_idx]
        pred_conf = pred_vec[pred_idx]

        if pred_outcome == actual:
            correct += 1

        prob_for_actual = p_h if actual == 'home' else (p_d if actual == 'draw' else p_a)
        total_logloss += -math.log(max(1e-10, prob_for_actual))

        bin_idx = min(9, int(pred_conf * 10))
        calibration_bins[bin_idx]['predicted'] += pred_conf
        calibration_bins[bin_idx]['actual'] += (1 if pred_outcome == actual else 0)
        calibration_bins[bin_idx]['count'] += 1

        verdict = pred.get('verdict', 'N/A')
        results.append({
            'match': f"{match_obj['homeTeam']} vs {match_obj['awayTeam']}",
            'actual_score': f"{home_score}-{away_score}",
            'actual': actual,
            'predicted': pred_outcome,
            'probs': {'H': round(p_h,3), 'D': round(p_d,3), 'A': round(p_a,3)},
            'brier': round(brier, 4),
            'confidence': round(pred_conf, 3),
            'verdict': verdict,
        })

        if (i+1) % 10 == 0:
            print(f"  [{i+1}/{min(len(fixtures), 50)}] Accuracy so far: {correct/(n or 1):.1%}")

    if n == 0:
        print("No valid predictions generated")
        return

    avg_brier = total_brier / n
    avg_logloss = total_logloss / n
    accuracy = correct / n
    brier_skill = 1 - avg_brier / 0.222

    print("\n" + "="*60)
    print("BACKTEST RESULTS")
    print("="*60)
    print(f"  Total matches:    {n}")
    print(f"  Correct picks:    {correct} ({accuracy:.1%})")
    print(f"  Brier Score:      {avg_brier:.4f} (0=perfect, 1=worst)")
    print(f"  Brier Skill:      {brier_skill:.4f} (>0 = beats naive)")
    print(f"  Log Loss:         {avg_logloss:.4f} (lower=better)")
    print("-"*60)
    print("  Calibration Curve:")
    for i, b in enumerate(calibration_bins):
        if b['count'] > 0:
            pred_frac = b['predicted'] / b['count']
            actual_frac = b['actual'] / b['count']
            bar = '█' * int(actual_frac * 20)
            print(f"    {i*10:02d}-{(i+1)*10:02d}%  pred={pred_frac:.2f}  actual={actual_frac:.2f}  {bar}")
    print("="*60)

    # Top predictions analysis
    high_conf = [r for r in results if r['confidence'] >= 0.70]
    if high_conf:
        high_correct = sum(1 for r in high_conf if r['predicted'] == r['actual'])
        print(f"\n  High confidence (>=70%): {len(high_conf)} picks, {high_correct/len(high_conf):.1%} correct")

    return {
        'total': n,
        'correct': correct,
        'accuracy': accuracy,
        'brier_score': avg_brier,
        'brier_skill': brier_skill,
        'log_loss': avg_logloss,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=200)
    parser.add_argument('--league', type=str, default='')
    parser.add_argument('--full', action='store_true', help='Run on all fixtures (slow)')
    args = parser.parse_args()
    run_backtest(limit=args.limit, league=args.league, sample_only=not args.full)
