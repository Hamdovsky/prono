"""Tests de generate_pronostics (command_center) — section Market Engine VALUE."""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

import command_center as cc


def test_real_markets_value_surfaced_as_pronostic():
    m = {
        'homeTeam': 'A', 'awayTeam': 'B',
        'home_win_probability': 60.0, 'draw_probability': 20.0, 'away_win_probability': 20.0,
        'ou_25_prob': 70.0, 'btts_prob': 60.0, 'xgboost_confidence': 0.7,
        'real_markets_value': [
            {'market': 'BTTS - Oui', 'real_odds': 1.8, 'implied_probability': 55.0,
             'model_probability': 70.0, 'edge_pct': 15.0},
        ],
    }
    out = cc.generate_pronostics(m)
    rm = [p for p in out if p.get('source') == 'real_markets']
    assert rm, "aucun pronostic real_markets"
    assert rm[0]['grade'] == 'strong'
    assert 'edge' in rm[0]['reason'].lower()
    assert '+15' in rm[0]['value']


def test_no_real_markets_no_extra_pronostic():
    m = {
        'homeTeam': 'A', 'awayTeam': 'B',
        'home_win_probability': 60.0, 'draw_probability': 20.0, 'away_win_probability': 20.0,
        'ou_25_prob': 70.0, 'btts_prob': 60.0, 'xgboost_confidence': 0.7,
    }
    out = cc.generate_pronostics(m)
    assert all(p.get('source') != 'real_markets' for p in out)


def test_real_markets_value_json_string_parsed():
    m = {
        'homeTeam': 'A', 'awayTeam': 'B',
        'home_win_probability': 60.0, 'draw_probability': 20.0, 'away_win_probability': 20.0,
        'ou_25_prob': 70.0, 'btts_prob': 60.0, 'xgboost_confidence': 0.7,
        'real_markets_value': '[{"market":"Over 2.5 Buts","real_odds":1.9,"implied_probability":53,"model_probability":80,"edge_pct":27}]',
    }
    out = cc.generate_pronostics(m)
    rm = [p for p in out if p.get('source') == 'real_markets']
    assert rm, "real_markets_value (string JSON) non parse"
    assert rm[0]['market'].startswith('💰')
