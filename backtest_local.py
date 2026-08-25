"""
backtest_local.py — Run backtest against local SQLite archive (falls back when Neon quota exceeded).
Mirrors core/backtest_pipeline.py but reads finished fixtures from data/historical_archive.sqlite.
Usage: python backtest_local.py [--limit 200]
"""
import os, sys, json, math, argparse, sqlite3

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
sys.path.insert(0, os.path.join(BASE, 'core'))

LEAGUE_CODE_MAP = {
    'E0': 'Premier League',
    'SP1': 'La Liga',
    'I1': 'Serie A',
    'F1': 'Ligue 1',
    'D1': 'Bundesliga',
}

def fetch_local_fixtures(limit=200):
    conn = sqlite3.connect(os.path.join(BASE, 'data', 'historical_archive.sqlite'))
    cur = conn.cursor()
    rows = cur.execute("""
        SELECT home_team, away_team, league_code, score_home, score_away,
               odds_home, odds_draw, odds_away, match_date
        FROM archive_football_data
        WHERE score_home IS NOT NULL AND score_away IS NOT NULL
          AND odds_home IS NOT NULL AND odds_draw IS NOT NULL AND odds_away IS NOT NULL
          AND odds_home > 1.01 AND odds_draw > 1.01 AND odds_away > 1.01
        ORDER BY match_date DESC
        LIMIT ?
    """, (limit,)).fetchall()
    conn.close()

    from datetime import datetime, timezone
    result = []
    for r in rows:
        ts = 0
        try:
            if r[8]:
                ts = int(datetime.strptime(r[8], '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp())
        except Exception:
            ts = 0
        result.append({
            'home_team': r[0], 'away_team': r[1], 'league_name': LEAGUE_CODE_MAP.get(r[2], r[2]),
            'goals_home': r[3], 'goals_away': r[4],
            'odds_home': r[5], 'odds_draw': r[6], 'odds_away': r[7],
            'startTimestamp': ts,
        })
    return result

def run_backtest(limit=200):
    fixtures = fetch_local_fixtures(limit)
    print("Loaded %d test fixtures from local archive" % len(fixtures))

    samples = []  # (confidence, is_correct) for isotonic refit

    from prediction_engine import process_prediction

    results = []
    correct = 0
    total_brier = 0.0
    total_logloss = 0.0
    n = 0
    calibration_bins = [{"predicted": 0.0, "actual": 0.0, "count": 0} for _ in range(10)]
    vetoed = 0
    no_value = 0

    for i, f in enumerate(fixtures):
        home_score = f.get('goals_home') or 0
        away_score = f.get('goals_away') or 0

        actual = 'home' if home_score > away_score else ('away' if home_score < away_score else 'draw')
        actual_vec = [1 if actual == 'home' else 0, 1 if actual == 'draw' else 0, 1 if actual == 'away' else 0]

        match_obj = {
            'homeTeam': f.get('home_team', 'Home'),
            'awayTeam': f.get('away_team', 'Away'),
            'league': f.get('league_name', 'Unknown'),
            'odds_home': float(f.get('odds_home', 2.0)),
            'odds_away': float(f.get('odds_away', 2.0)),
            'odds_draw': float(f.get('odds_draw', 3.0)),
            'startTimestamp': f.get('startTimestamp', 0),
            'force_predict': True,
        }

        try:
            pred = process_prediction(match_obj)
        except Exception as e:
            print("  [%d/%d] Prediction error: %s" % (i+1, len(fixtures), e))
            continue

        if not pred.get('success'):
            err = pred.get('error', pred.get('verdict', 'unknown'))
            if any(k in str(err).upper() for k in ('VETO', 'KEY_ABSENCES', 'SHARP')):
                vetoed += 1
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

        samples.append({
            'confidence': round(pred_conf * 100.0, 2),
            'is_correct': pred_outcome == actual,
        })

        results.append({
            'match': "%s vs %s" % (match_obj['homeTeam'], match_obj['awayTeam']),
            'actual': actual,
            'predicted': pred_outcome,
            'confidence': round(pred_conf, 3),
            'brier': round(brier, 4),
            'verdict': pred.get('verdict', 'N/A'),
        })

        if (i+1) % 25 == 0:
            print("  [%d/%d] Accuracy so far: %.1f%%" % (i+1, len(fixtures), (correct/(n or 1))*100))

    if n == 0:
        print("No valid predictions generated")
        return

    avg_brier = total_brier / n
    avg_logloss = total_logloss / n
    accuracy = correct / n
    brier_skill = 1 - avg_brier / 0.222

    print("\n" + "="*60)
    print("LOCAL BACKTEST RESULTS")
    print("="*60)
    print("  Total matches:    %d" % n)
    print("  Correct picks:    %d (%.1f%%)" % (correct, accuracy*100))
    print("  Brier Score:      %.4f (0=perfect, 1=worst)" % avg_brier)
    print("  Brier Skill:      %.4f (>0 = beats naive)" % brier_skill)
    print("  Log Loss:         %.4f (lower=better)" % avg_logloss)
    print("  Vetoed matches:   %d" % vetoed)
    print("-"*60)
    print("  Calibration Curve:")
    for i, b in enumerate(calibration_bins):
        if b['count'] > 0:
            pred_frac = b['predicted'] / b['count']
            actual_frac = b['actual'] / b['count']
            bar = '#' * int(actual_frac * 20)
            print("    %02d-%02d%%  pred=%.2f  actual=%.2f  %s" % (i*10, (i+1)*10, pred_frac, actual_frac, bar))
    print("="*60)

    high_conf = [r for r in results if r['confidence'] >= 0.70]
    if high_conf:
        high_correct = sum(1 for r in high_conf if r['predicted'] == r['actual'])
        print("\n  High confidence (>=70%%): %d picks, %.1f%% correct" % (len(high_conf), (high_correct/len(high_conf))*100))

    return {
        'total': n,
        'correct': correct,
        'accuracy': accuracy,
        'brier_score': avg_brier,
        'brier_skill': brier_skill,
        'log_loss': avg_logloss,
        'samples': samples,
    }

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=200)
    parser.add_argument('--no-iso', action='store_true', help='Bypass stale isotonic calibration')
    parser.add_argument('--refit', action='store_true', help='Collect samples and refit isotonic calibration')
    args = parser.parse_args()

    if args.no_iso:
        import calibration_iso
        calibration_iso._load_model = lambda: None
        calibration_iso.isotonic_calibrate = lambda p_h, p_d, p_a: (p_h, p_d, p_a)
        import confidence_engine
        confidence_engine.isotonic_calibrate = calibration_iso.isotonic_calibrate
        print(">> Isotonic calibration BYPASSED (raw model)")

    result = run_backtest(limit=args.limit)

    if args.refit and result and result.get('samples'):
        samples = result['samples']
        print("\n>> Refitting isotonic calibration on %d collected 1X2 samples..." % len(samples))
        import json
        import calibration_iso
        log_path = os.path.join(BASE, 'data', 'accuracy_log.json')
        log = {}
        try:
            with open(log_path, 'r', encoding='utf-8') as f:
                log = json.load(f)
        except Exception:
            log = {}
        if not isinstance(log, dict):
            log = {}
        entries = log.get('entries')
        if not isinstance(entries, list):
            entries = []
            log['entries'] = entries
        for s in samples:
            entries.append({
                'market': '1X2',
                'confidence': s['confidence'],
                'is_correct': s['is_correct'],
            })
        with open(log_path, 'w', encoding='utf-8') as f:
            json.dump(log, f, indent=2)
        print(">> Appended %d samples to %s" % (len(samples), log_path))

        from calibration_iso import fit
        fit()