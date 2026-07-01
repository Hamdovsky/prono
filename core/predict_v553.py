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
        'tournament_name': match.get('tournament_name', league),
        'startTimestamp': ts,
        'match_date': match.get('match_date', ''),
        'form_context': match.get('form_context', '{}') or '{}',
        'h2h_data': match.get('h2h_data', '{}') or '{}',
        'player_ratings_home': match.get('player_ratings_home', '[]') or '[]',
        'player_ratings_away': match.get('player_ratings_away', '[]') or '[]',
        'home_att': match.get('home_att', 1.0),
        'away_att': match.get('away_att', 1.0),
        'news_sentiment': match.get('news_sentiment', 0),
        'news_data': match.get('news_data', None),
        'weather_temp': match.get('weather_temp', 20.0),
        'weather_desc': match.get('weather_desc', ''),
        'weather_humidity': match.get('weather_humidity', None),
        'days_since_last_match_home': match.get('days_since_last_match_home', 90),
        'days_since_last_match_away': match.get('days_since_last_match_away', 90),
        'odds_movement_24h': match.get('odds_movement_24h', '{}') or '{}',
        'odds_home': match.get('odds_home', 2.5),
        'odds_draw': match.get('odds_draw', 3.2),
        'odds_away': match.get('odds_away', 2.8),
        'odds_home_open': match.get('odds_home_open', match.get('odds_home', 2.5)),
        'stats_blob': match.get('stats_blob', '[]') or '[]',
        'scoreHome': match.get('scoreHome'),
        'scoreAway': match.get('scoreAway'),
        'teamStats': match.get('teamStats', None),
        'historical_context': match.get('historical_context', None),
        'country_iso': match.get('country_iso', None),
        'category_name': match.get('category_name', None),
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

    # Detect if xG is a default (no real data) — check data_completeness
    dc = base_feats.get('data_completeness', 100)
    is_default_xg = dc < 30.0 or (xg_h == 1.0 and xg_a == 1.0)

    # Odds-implied xG: always use when data is thin
    odds_h = float(match.get('odds_home', 0) or 0)
    odds_d = float(match.get('odds_draw', 0) or 0)
    odds_a = float(match.get('odds_away', 0) or 0)
    if is_default_xg and odds_h > 1.1 and odds_d > 1.1 and odds_a > 1.1:
        implied_h = 1.0 / odds_h
        implied_d = 1.0 / odds_d
        implied_a = 1.0 / odds_a
        total = implied_h + implied_d + implied_a
        nh, nd, na = implied_h / total, implied_d / total, implied_a / total
        xg_h = max(0.4, min(3.0, nh * 3.0))
        xg_a = max(0.4, min(3.0, na * 3.0))

    # If xG is still default after odds-implied fallback, derive from XGBoost probs
    if is_default_xg or (xg_h == 1.0 and xg_a == 1.0):
        odds_h = float(match.get('odds_home', 0) or 0)
        odds_d = float(match.get('odds_draw', 0) or 0)
        odds_a = float(match.get('odds_away', 0) or 0)
        if odds_h > 1.1 and odds_d > 1.1 and odds_a > 1.1:
            implied_h = 1.0 / odds_h
            implied_d = 1.0 / odds_d
            implied_a = 1.0 / odds_a
            total_imp = implied_h + implied_d + implied_a
            nh, nd, na = implied_h / total_imp, implied_d / total_imp, implied_a / total_imp
            max_implied = max(nh, na)
            total_xg = 1.5 + 1.5 * max_implied
        else:
            total_xg = 2.0
        p_sum = probs_map['1'] + probs_map['2']
        if p_sum > 0:
            p_h_ratio = probs_map['1'] / p_sum
            draw_factor = probs_map['X'] / 100.0
            balance = min(1.0, draw_factor * 3.0)
            xg_h = total_xg * (balance * 0.5 + (1.0 - balance) * (0.4 + 0.6 * p_h_ratio))
            xg_a = max(0.3, total_xg - xg_h)
            xg_h = max(0.4, min(4.0, xg_h))

    # Poisson most likely score instead of naive round(xG)
    from math import exp, factorial
    def _poisson_mode(lam):
        lam = max(0.1, min(5.0, lam))
        k, best_p, best_k = 0, 0, 0
        while k < 8:
            p = (lam ** k) * exp(-lam) / factorial(k)
            if p > best_p:
                best_p, best_k = p, k
            k += 1
        return best_k

    score_h = _poisson_mode(xg_h)
    score_a = _poisson_mode(xg_a)
    expected_score = f'{score_h} - {score_a}'

    return {
        'success': True,
        'prediction': label_map[pred_class],
        'home_win_prob': probs_map['1'],
        'draw_prob': probs_map['X'],
        'away_win_prob': probs_map['2'],
        'expected_score': expected_score,
        'home_xg': round(xg_h, 2),
        'away_xg': round(xg_a, 2),
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
