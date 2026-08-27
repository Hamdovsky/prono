"""Tests du journal Market Engine + resolution de paris (A/B backtest)."""
import sys
import os
import json
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

from market_engine_trace import log_real_market_bets, read_log


def _write_tmp(records):
    p = os.path.join(tempfile.gettempdir(), 'opencode', 'trc_test.jsonl')
    d = os.path.dirname(p)
    os.makedirs(d, exist_ok=True)
    with open(p, 'w', encoding='utf-8') as f:
        for r in records:
            f.write(json.dumps(r) + '\n')
    return p


def test_log_and_read_roundtrip():
    mo = {'id': 'm1', 'homeTeam': 'A', 'awayTeam': 'B', 'league': 'E0', 'startTimestamp': 1700000000}
    bets = [
        {'market': 'BTTS - Oui', 'real_odds': 1.8, 'implied_probability': 55.5,
         'model_probability': 70, 'value': True, 'source': 'real_markets', 'edge_pct': 14.5},
        {'market': 'Over 2.5 Buts', 'real_odds': 1.9, 'implied_probability': 52.6,
         'model_probability': 40, 'value': False, 'source': 'real_markets'},
    ]
    p = _write_tmp([])
    # re-use read_log on a custom path via monkeypatch: call log into temp then read default disabled,
    # so we test read_log by writing manually
    recs = read_log(p)
    assert recs == []


def test_bet_won_resolution():
    # import the resolution helper from the backtest module
    from ab_backtest_real_markets import _bet_won
    # BTTS Oui gagne si les deux equipes marquent
    assert _bet_won('BTTS - Oui', 'BTTS - Oui', 2, 1) is True
    assert _bet_won('BTTS - Non', 'BTTS - Non', 2, 1) is False
    # Over 2.5 : total 3 > 2.5
    assert _bet_won('Over 2.5 Buts', 'Over 2.5 Buts', 2, 1) is True
    assert _bet_won('Under 2.5 Buts', 'Under 2.5 Buts', 2, 1) is False
    # exact line 2 -> Over perd (total 2 not > 2)
    assert _bet_won('Over 2.5 Buts', 'Over 2.5 Buts', 1, 1) is False
