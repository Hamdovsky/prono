#!/usr/bin/env python3
"""
Test V553 Premium on WC 2026 match results.
Loads model, builds features via extract_ml_features, predicts, compares.
"""
import sys, os, json, sqlite3
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

os.environ['STITCH_ENV'] = 'development'

from ml_features import extract_ml_features, FEATURE_NAMES_V553, get_wc2026_team_data

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'historical_archive.sqlite')

def get_xgb():
    import xgboost as xgb
    return xgb

def load_v553_premium():
    import xgboost as xgb
    path = os.path.join(os.path.dirname(__file__), '..', 'models', 'stitch_v553_premium.json')
    if not os.path.exists(path):
        print(f'Model not found: {path}')
        return None
    bst = xgb.Booster()
    bst.load_model(path)
    return bst

def load_wc2026_results():
    """Load WC 2026 matches with actual results"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM wc2026_matches WHERE score_ft_home IS NOT NULL AND score_ft_away IS NOT NULL ORDER BY match_date"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]

def main():
    print('=' * 60)
    print('  WC 2026 — V553 Premium Prediction Test')
    print('=' * 60)

    model = load_v553_premium()
    if model is None:
        print('[FAIL] Model not found')
        return

    print(f'[OK] Model loaded: models/stitch_v553_premium.json')
    print(f'[OK] Feature names: {len(FEATURE_NAMES_V553)} features')

    # Pre-load WC2026 team data
    get_wc2026_team_data()
    print('[OK] WC2026 team data loaded')

    matches = load_wc2026_results()
    print(f'[OK] {len(matches)} WC 2026 matches with results\n')

    correct = 0
    total = 0
    results = []
    xgb = get_xgb()

    for m in matches:
        home = m.get('team1', '')
        away = m.get('team2', '')
        score_h = m.get('score_ft_home')
        score_a = m.get('score_ft_away')
        date = str(m.get('match_date', ''))[:10]

        if not home or not away or score_h is None or score_a is None:
            continue

        actual = 0 if score_h > score_a else (1 if score_h == score_a else 2)
        actual_label = '1' if actual == 0 else 'N' if actual == 1 else '2'

        match = {
            'homeTeam': home,
            'awayTeam': away,
            'league': 'World Cup 2026',
            'tournament_name': 'World Cup 2026',
            'startTimestamp': 1755000000,
            'odds_home': 2.5,
            'odds_draw': 3.2,
            'odds_away': 2.8,
            'home_xg': 0,
            'away_xg': 0,
            'weather_temp': 20.0,
            'days_since_last_match_home': 90,
            'days_since_last_match_away': 90,
        }
        if m.get('ground'):
            match['venue'] = m['ground']

        features = extract_ml_features(match, fetch_history=False)
        vec = np.array([[float(features.get(f, 0)) for f in FEATURE_NAMES_V553]], dtype=float)
        vec = np.nan_to_num(vec, nan=0.0)

        dmat = xgb.DMatrix(vec, feature_names=FEATURE_NAMES_V553)
        probs = model.predict(dmat)[0]

        p_h, p_d, p_a = float(probs[0]), float(probs[1]), float(probs[2])
        pred = 0 if p_h >= max(p_d, p_a) else (1 if p_d >= max(p_h, p_a) else 2)
        pred_label = '1' if pred == 0 else 'N' if pred == 1 else '2'
        is_correct = pred == actual

        if is_correct:
            correct += 1
        total += 1

        results.append({
            'date': date,
            'match': f'{home} vs {away}',
            'score': f'{score_h}-{score_a}',
            'probs': f'{p_h*100:.0f}/{p_d*100:.0f}/{p_a*100:.0f}',
            'pred': pred_label,
            'actual': actual_label,
            'correct': is_correct,
            'confidence': max(p_h, p_d, p_a) * 100,
        })

        marker = '+' if is_correct else '-'
        print(f'  {marker} {date} | {home:25s} vs {away:25s} | {score_h}-{score_a} | '
              f'pred={pred_label} act={actual_label} | '
              f'({p_h*100:.0f}/{p_d*100:.0f}/{p_a*100:.0f}) '
              f'{"CORRECT" if is_correct else "WRONG"}')

    print('\n' + '=' * 60)
    print(f'  WC 2026 Results: {correct}/{total} = {correct/total*100:.2f}%')
    print('=' * 60)

    # Per-class breakdown
    by_class = {}
    for r in results:
        cls = r['actual']
        by_class.setdefault(cls, {'t': 0, 'c': 0})
        by_class[cls]['t'] += 1
        if r['correct']:
            by_class[cls]['c'] += 1
    print('\n  Per-class:')
    for cls in ['1', 'N', '2']:
        d = by_class.get(cls, {'t': 0, 'c': 0})
        acc = d['c'] / d['t'] * 100 if d['t'] else 0
        print(f'    {cls}: {d["c"]}/{d["t"]} = {acc:.1f}%')

    # Confidence bands
    bands = {'0-49': [], '50-69': [], '70-89': [], '90-100': []}
    for r in results:
        c = r['confidence']
        if c < 50: bands['0-49'].append(r)
        elif c < 70: bands['50-69'].append(r)
        elif c < 90: bands['70-89'].append(r)
        else: bands['90-100'].append(r)

    print('\n  By confidence:')
    for band, items in bands.items():
        if items:
            acc = sum(1 for i in items if i['correct']) / len(items) * 100
            print(f'    {band}: {acc:.1f}% ({len(items)} matches)')

    return correct, total, results

if __name__ == '__main__':
    main()
