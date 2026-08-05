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
