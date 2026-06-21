import sys, os, json, sqlite3, time, math, argparse, io
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

from prediction_engine import process_prediction
from train_titanium_v4 import FEATURE_NAMES_V4, extract_features_from_row, _f, load_data

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'historical_archive.sqlite')
SAMPLE_SIZE = 200

def load_matches(limit=SAMPLE_SIZE):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT * FROM archive_matches 
        WHERE scoreHome IS NOT NULL AND stats_blob IS NOT NULL 
        ORDER BY RANDOM() LIMIT ?
    """, (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]

def build_match_payload(row):
    feats = {}
    try:
        stats = json.loads(row.get('stats_blob', '[]'))
    except:
        stats = []
    h2h = row.get('h2h_data')
    if isinstance(h2h, str):
        try: h2h = json.loads(h2h)
        except: h2h = None
    odds = row.get('odds_movement_24h')
    if isinstance(odds, str):
        try: odds = json.loads(odds)
        except: odds = None
    # Extract odds from odds_movement_24h JSON (no separate odds columns in archive)
    oh = 2.0; od = 3.0; oa = 3.0
    if odds and isinstance(odds, dict):
        pre = odds.get('preMatch') or odds
        if isinstance(pre, dict):
            oh = float(pre.get('home', pre.get('1', 2.0)))
            od = float(pre.get('draw', pre.get('X', 3.0)))
            oa = float(pre.get('away', pre.get('2', 3.0)))
    # Set to 0 if no real odds (triggers market=None in confluence_guard)
    if oh == 2.0 and od == 3.0 and oa == 3.0:
        oh = 0; od = 0; oa = 0
    return {
        'id': row.get('sofascore_id') or row.get('id'),
        'homeTeam': row.get('homeTeam', 'Unknown'),
        'awayTeam': row.get('awayTeam', 'Unknown'),
        'league': row.get('tournament_name', 'Unknown'),
        'odds_home': float(oh),
        'odds_draw': float(od),
        'odds_away': float(oa),
        'homeTeam': row.get('homeTeam'),
        'awayTeam': row.get('awayTeam'),
        'home_xg': row.get('home_xg', 0) or 0,
        'away_xg': row.get('away_xg', 0) or 0,
        'home_possession': row.get('home_possession', 0) or 0,
        'away_possession': row.get('away_possession', 0) or 0,
        'home_shots': row.get('home_shots', 0) or 0,
        'away_shots': row.get('away_shots', 0) or 0,
        'home_shots_on_target': row.get('home_shots_on_target', 0) or 0,
        'away_shots_on_target': row.get('away_shots_on_target', 0) or 0,
        'home_corners': row.get('home_corners', 0) or 0,
        'away_corners': row.get('away_corners', 0) or 0,
        'home_fouls': row.get('home_fouls', 0) or 0,
        'away_fouls': row.get('away_fouls', 0) or 0,
        'stats': stats,
        'h2h_data': h2h,
        'odds_movement_24h': odds,
        'startTimestamp': row.get('startTimestamp')
    }

def validate_v4():
    """Validate V4 model directly on archive DB (post-match stats → prediction)."""
    import xgboost as xgb
    MODEL_PATH = os.path.join(os.path.dirname(__file__), '..', 'models', 'titanium_v4.json')
    if not os.path.exists(MODEL_PATH):
        print(f"Model not found: {MODEL_PATH}")
        return

    bst = xgb.Booster()
    bst.load_model(MODEL_PATH)
    print(f"V4 model loaded: {MODEL_PATH}")

    rows = load_data()
    if not rows:
        print("No data found!")
        return

    # Sort by timestamp, take last SAMPLE_SIZE as "unseen" test
    rows.sort(key=lambda r: r.get('startTimestamp', 0) or 0)
    test_rows = rows[-SAMPLE_SIZE:]
    print(f"Testing on {len(test_rows)} most recent archive matches\n")

    correct, total = 0, 0
    by_confidence = {}
    by_league = {}
    results = []

    for i, row in enumerate(test_rows):
        feats = extract_features_from_row(row)
        vec = np.array([[feats.get(f, 0.0) for f in FEATURE_NAMES_V4]], dtype=float)
        vec = np.nan_to_num(vec, nan=0.0)

        h = _f(row.get('scoreHome'), 0)
        a = _f(row.get('scoreAway'), 0)
        actual = '1' if h > a else 'N' if h == a else '2'
        league = row.get('tournament_name', 'Unknown')

        dmat = xgb.DMatrix(vec)
        probs = bst.predict(dmat)[0]
        p_h, p_d, p_a = float(probs[2]), float(probs[1]), float(probs[0])

        confidence = max(p_h, p_d, p_a) * 100
        predicted = '1' if p_h >= max(p_d, p_a) else 'N' if p_d >= max(p_h, p_a) else '2'
        is_correct = predicted == actual

        if is_correct: correct += 1
        total += 1

        band = f"{int(confidence//10*10)}-{min(int(confidence//10*10+9), 100)}%"
        by_confidence.setdefault(band, {'t': 0, 'c': 0})
        by_confidence[band]['t'] += 1
        if is_correct: by_confidence[band]['c'] += 1

        by_league.setdefault(league, {'t': 0, 'c': 0})
        by_league[league]['t'] += 1
        if is_correct: by_league[league]['c'] += 1

        results.append({
            'match': f"{row.get('homeTeam','?')} vs {row.get('awayTeam','?')}",
            'predicted': predicted, 'actual': actual,
            'probs': f"{p_h*100:.0f}/{p_d*100:.0f}/{p_a*100:.0f}",
            'correct': is_correct,
            'confidence': round(confidence, 1),
            'source': 'V4-RAW',
            'score': f"{int(h)}-{int(a)}"
        })

        if (i+1) % 50 == 0 or (i+1) == len(test_rows):
            print(f"  [{i+1}/{len(test_rows)}] {correct}/{total} correct ({correct/total*100:.1f}%)")

    print_result_summary(total, correct, results, by_confidence, by_league, times=[])

def print_result_summary(total, correct, results, by_confidence, by_league, times):
    print("\n" + "="*60)
    print(f"VALIDATION RESULTS — {total} matches")
    print("="*60)
    print(f"Overall Accuracy: {correct}/{total} = {correct/total*100:.2f}%")
    if times:
        print(f"Avg inference time: {sum(times)/len(times):.2f}s ({min(times):.2f}s-{max(times):.2f}s)")

    print(f"\n--- By Confidence Band ---")
    for band in sorted(by_confidence.keys(), key=lambda x: int(x.split('-')[0])):
        d = by_confidence[band]
        acc = d['c']/d['t']*100 if d['t'] else 0
        print(f"  {band}: {d['c']}/{d['t']} = {acc:.1f}%")

    leagues_sorted = sorted(by_league.items(), key=lambda x: -x[1]['t'])[:10]
    print(f"\n--- Top 10 Leagues ---")
    for league, d in leagues_sorted:
        acc = d['c']/d['t']*100 if d['t'] else 0
        print(f"  {league[:40]}: {d['c']}/{d['t']} = {acc:.1f}%")

    source_counts = {}
    for r in results:
        src = r['source']
        source_counts.setdefault(src, {'t': 0, 'c': 0})
        source_counts[src]['t'] += 1
        if r['correct']: source_counts[src]['c'] += 1

    print(f"\n--- By AI Source ---")
    for src, d in sorted(source_counts.items(), key=lambda x: -x[1]['t']):
        acc = d['c']/d['t']*100 if d['t'] else 0
        print(f"  {src}: {d['c']}/{d['t']} = {acc:.1f}%")

    mispredictions = [r for r in results if not r['correct'] and r['confidence'] >= 70]
    if mispredictions:
        print(f"\n--- High-Confidence Misses (>70%) — {len(mispredictions)} ---")
        for r in mispredictions[:10]:
            print(f"  {r['match']}: pred={r['predicted']} actual={r['actual']} ({r['probs']}) [{r['source']}]")

def validate_pipeline():
    print(f"Loading {SAMPLE_SIZE} random matches for pipeline validation...")
    matches = load_matches()
    if not matches:
        print("No matches found!")
        return

    results = []
    correct = 0
    total = 0
    by_confidence = {}
    by_league = {}
    times = []

    for i, row in enumerate(matches):
        match = build_match_payload(row)
        actual_h = row['scoreHome']
        actual_a = row['scoreAway']
        if actual_h > actual_a: actual = '1'
        elif actual_h == actual_a: actual = 'N'
        else: actual = '2'

        t0 = time.time()
        try:
            pred = process_prediction(match)
            elapsed = time.time() - t0
            times.append(elapsed)
        except Exception as e:
            print(f"  [{i+1}/{SAMPLE_SIZE}] FAIL {match['homeTeam']} vs {match['awayTeam']}: {e}")
            continue

        if not pred.get('success', False):
            print(f"  [{i+1}/{SAMPLE_SIZE}] SKIP {match['homeTeam']} vs {match['awayTeam']}: {pred.get('error', 'unknown')}")
            continue

        p_h = pred.get('home_win_probability', pred.get('p_h', 0))
        p_d = pred.get('draw_probability', pred.get('p_d', 0))
        p_a = pred.get('away_win_probability', pred.get('p_a', 0))
        confidence = max(p_h, p_d, p_a) * 100
        predicted = '1' if p_h >= max(p_d, p_a) else 'N' if p_d >= max(p_h, p_a) else '2'
        is_correct = predicted == actual

        if is_correct: correct += 1
        total += 1

        band = f"{int(confidence//10*10)}-{int(confidence//10*10+9)}%"
        by_confidence.setdefault(band, {'t': 0, 'c': 0})
        by_confidence[band]['t'] += 1
        if is_correct: by_confidence[band]['c'] += 1

        league = match['league'] or 'Unknown'
        by_league.setdefault(league, {'t': 0, 'c': 0})
        by_league[league]['t'] += 1
        if is_correct: by_league[league]['c'] += 1

        # Also get raw XGB probs if available from pipeline
        raw_ph = pred.get('p_h_xgb', pred.get('xgboost_probs_h', None))
        raw_pd = pred.get('p_d_xgb', pred.get('xgboost_probs_d', None))
        raw_pa = pred.get('p_a_xgb', pred.get('xgboost_probs_a', None))
        if raw_ph is None:
            # Check if returned in raw_prediction field
            raw_pred = pred.get('raw_prediction', pred.get('direct_prediction', None))
        raw_predicted = '?'
        if raw_ph is not None:
            raw_predicted = '1' if raw_ph >= max(raw_pd, raw_pa) else 'N' if raw_pd >= max(raw_ph, raw_pa) else '2'

        results.append({
            'match': f"{match['homeTeam']} vs {match['awayTeam']}",
            'predicted': predicted, 'actual': actual,
            'probs': f"{p_h*100:.0f}/{p_d*100:.0f}/{p_a*100:.0f}",
            'correct': is_correct,
            'confidence': round(confidence, 1),
            'source': pred.get('ai_source', '?'),
            'score': f"{actual_h}-{actual_a}",
            'raw_predicted': raw_predicted,
            'p_h_final': round(p_h, 4),
            'p_d_final': round(p_d, 4),
            'p_a_final': round(p_a, 4),
        })

        if (i+1) % 25 == 0:
            print(f"  [{i+1}/{SAMPLE_SIZE}] {correct}/{total} correct ({correct/total*100:.1f}%)")
    
    # Save results for debug analysis
    import json as _json
    with open('C:/Users/HAMDI/AppData/Local/Temp/opencode/validation_results.json', 'w') as _f:
        _json.dump(results, _f, indent=2, default=str)
    
    print_result_summary(total, correct, results, by_confidence, by_league, times)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['pipeline', 'v4'], default='pipeline')
    args = parser.parse_args()
    
    if args.mode == 'v4':
        validate_v4()
    else:
        validate_pipeline()

    print("\n" + "="*60)
    print(f"VALIDATION RESULTS — {total} matches")
    print("="*60)
    print(f"Overall Accuracy: {correct}/{total} = {correct/total*100:.2f}%")
    if times:
        print(f"Avg inference time: {sum(times)/len(times):.2f}s ({min(times):.2f}s-{max(times):.2f}s)")

    print(f"\n--- By Confidence Band ---")
    for band in sorted(by_confidence.keys(), key=lambda x: int(x.split('-')[0])):
        d = by_confidence[band]
        acc = d['c']/d['t']*100 if d['t'] else 0
        print(f"  {band}: {d['c']}/{d['t']} = {acc:.1f}%")

    leagues_sorted = sorted(by_league.items(), key=lambda x: -x[1]['t'])[:10]
    print(f"\n--- Top 10 Leagues ---")
    for league, d in leagues_sorted:
        acc = d['c']/d['t']*100 if d['t'] else 0
        print(f"  {league[:40]}: {d['c']}/{d['t']} = {acc:.1f}%")

    source_counts = {}
    for r in results:
        src = r['source']
        source_counts.setdefault(src, {'t': 0, 'c': 0})
        source_counts[src]['t'] += 1
        if r['correct']: source_counts[src]['c'] += 1

    print(f"\n--- By AI Source ---")
    for src, d in sorted(source_counts.items(), key=lambda x: -x[1]['t']):
        acc = d['c']/d['t']*100 if d['t'] else 0
        print(f"  {src}: {d['c']}/{d['t']} = {acc:.1f}%")

    mispredictions = [r for r in results if not r['correct'] and r['confidence'] >= 70]
    if mispredictions:
        print(f"\n--- High-Confidence Misses (>70%) — {len(mispredictions)} ---")
        for r in mispredictions[:10]:
            print(f"  {r['match']}: pred={r['predicted']} actual={r['actual']} ({r['probs']}) [{r['source']}]")

if __name__ == '__main__':
    main()
