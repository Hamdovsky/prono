#!/usr/bin/env python3
"""
predict_v553.py — V553_PREMIUM inference via stdin/stdout
Reads match JSON from stdin, outputs prediction JSON to stdout.
Usage: echo '{"homeTeam":"...","awayTeam":"...","league":"..."}' | python core/predict_v553.py
"""
import sys, os, json, math, traceback

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, 'core'))

import xgboost as xgb
import numpy as np
from ml_features import extract_ml_features, FEATURE_NAMES_V553
from top_analyst_engine import process_match_for_top_analyst

MODEL_PATH = os.path.join(BASE_DIR, 'models', 'stitch_v553_premium.json')

_bst = None
_initialized = False

def get_booster():
    global _bst, _initialized
    if not _initialized:
        _bst = xgb.Booster()
        _bst.load_model(MODEL_PATH)
        _initialized = True
    return _bst

def predict(match):
    home = match.get('homeTeam', 'Unknown')
    away = match.get('awayTeam', 'Unknown')
    league = match.get('league', 'International')
    ts = match.get('startTimestamp', 0)
    if ts and isinstance(ts, str):
        try: ts = int(ts)
        except: ts = 0
    if ts and ts > 1e11: ts = ts / 1000

    row = {
        'homeTeam': home,
        'awayTeam': away,
        'league': league,
        'tournament_name': league,
        'startTimestamp': ts,
        'match_date': match.get('match_date', ''),
        'form_context': '{}',
        'h2h_data': '{}',
        'player_ratings_home': '[]',
        'player_ratings_away': '[]',
        'home_att': 1.0,
        'away_att': 1.0,
        'news_sentiment': 0,
        'weather_temp': 20.0,
        'days_since_last_match_home': 90,
        'days_since_last_match_away': 90,
        'odds_movement_24h': '{}',
        'odds_home': match.get('odds_home', 2.5),
        'odds_draw': match.get('odds_draw', 3.2),
        'odds_away': match.get('odds_away', 2.8),
        'odds_home_open': match.get('odds_home', 2.5),
        'stats_blob': '[]',
        'scoreHome': None,
        'scoreAway': None,
    }

    try:
        base_feats = extract_ml_features(row, fetch_history=True, current_match_ts=ts)
    except Exception as e:
        return {'success': False, 'error': f'Feature extraction failed: {str(e)}'}

    match_payload = {
        'homeTeam': home,
        'awayTeam': away,
        'league': league,
        'odds_home': row.get('odds_home', 2.0),
        'odds_draw': row.get('odds_draw', 3.0),
        'odds_away': row.get('odds_away', 3.0),
        'home_xg': base_feats.get('h_xg', 0),
        'away_xg': base_feats.get('a_xg', 0),
        'player_ratings_home': '[]',
        'player_ratings_away': '[]',
        'stats': [],
    }
    match_payload['odds_home_open'] = match_payload['odds_home']

    try:
        ta_result = process_match_for_top_analyst(match_payload)
    except Exception:
        ta_result = {'ml_features': {}}

    ta_feats = ta_result.get('ml_features', {})
    full_feats = {**base_feats, **ta_feats}
    row_vector = np.array([[full_feats.get(f, 0.0) for f in FEATURE_NAMES_V553]])

    bst = get_booster()
    dmat = xgb.DMatrix(row_vector)
    probs = bst.predict(dmat)[0]
    pred_class = int(np.argmax(probs))
    label_map = {0: '1', 1: 'X', 2: '2'}
    probs_map = {'1': round(float(probs[0]) * 100, 1), 'X': round(float(probs[1]) * 100, 1), '2': round(float(probs[2]) * 100, 1)}

    xg_h = base_feats.get('h_xg', 0)
    xg_a = base_feats.get('a_xg', 0)
    if xg_h == 0 and xg_a == 0:
        xg_h = base_feats.get('expected_goals_home', 1.0)
        xg_a = base_feats.get('expected_goals_away', 1.0)

    return {
        'success': True,
        'prediction': label_map[pred_class],
        'home_win_prob': probs_map['1'],
        'draw_prob': probs_map['X'],
        'away_win_prob': probs_map['2'],
        'expected_score': f'{round(xg_h)} - {round(xg_a)}',
        'confidence': max(probs_map.values()),
        'model': 'V553_PREMIUM',
    }

if __name__ == '__main__':
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            print(json.dumps({'success': False, 'error': 'Empty input'}))
            sys.exit(0)
        data = json.loads(raw)
        matches = data if isinstance(data, list) else [data]
        results = [predict(m) for m in matches]
        print(json.dumps(results if isinstance(data, list) else results[0], ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'success': False, 'error': str(e), 'traceback': traceback.format_exc()}, ensure_ascii=False))
