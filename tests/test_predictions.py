import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

import sqlite3
import json
import pytest
from prediction_engine import process_prediction


def _scheduled_matches(limit=10):
    db_path = os.path.join(os.path.dirname(__file__), '..', 'data', 'tactical.db')
    if not os.path.exists(db_path):
        return []
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute("SELECT fullData FROM matches WHERE status='scheduled' LIMIT ?", (limit,))
        return cur.fetchall()
    except sqlite3.Error:
        return []
    finally:
        conn.close()


def test_scheduled_matches_predictable():
    rows = _scheduled_matches()
    if not rows:
        pytest.skip("no scheduled matches in data/tactical.db")
    results = []
    for row in rows:
        match_data = json.loads(row[0])
        res = process_prediction(match_data)
        results.append(res.get('success'))
    assert any(results), "no scheduled match could be predicted"


def test_real_markets_flowed_into_precision_bets():
    """Integration: extend_precision_bets_with_real_markets renvoie l'entree
    real_markets (VALUE quand le modele bat la cote implicite)."""
    import prediction_engine as pe

    model_probs = {
        'home': 45.0, 'draw': 25.0, 'away': 30.0,
        'btts': 70.0, 'ou_25': 80.0, 'ou_35': 60.0, 'ou_15': 90.0,
    }
    real_markets = [
        {"source": "sofascore", "market_id": "btts", "selection": "yes", "odds": 1.8, "usable": True},
    ]
    bets = pe.extend_precision_bets_with_real_markets(
        real_markets, 2.1, 3.2, 3.4, model_probs
    )
    assert bets, "aucun pari real_markets"
    assert bets[0].get('value') is True, "BTTS 1.8 doit etre VALUE (modele 70% > 55%)"
    assert bets[0].get('market') == 'BTTS - Oui'
    # marche arriere : sans model_probs -> lecture seule (pas de value)
    ro = pe.extend_precision_bets_with_real_markets(real_markets, 2.1, 3.2, 3.4, {})
    assert ro[0].get('value') is False
