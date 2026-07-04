import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

import sqlite3
import json
from prediction_engine import process_prediction

with open('test_out2.txt', 'w', encoding='utf-8') as f:
    conn = sqlite3.connect('data/tactical.db')
    cur = conn.cursor()
    cur.execute("SELECT fullData FROM matches WHERE status='scheduled' LIMIT 10")
    rows = cur.fetchall()
    for row in rows:
        match_data = json.loads(row[0])
        res = process_prediction(match_data)
        if not res.get('success'):
            f.write(f"Prediction failed: {res.get('error')}\n")
            continue
        h = match_data.get('homeTeam', '?')
        a = match_data.get('awayTeam', '?')
        sc = res.get('expected_score', 'N/A')
        xgh = res.get('home_win_probability', 0) * res.get('expected_goals_total', 2.5)
        xga = res.get('away_win_probability', 0) * res.get('expected_goals_total', 2.5)
        ph = res.get('home_win_probability', 0) * 100
        pd_ = res.get('draw_probability', 0) * 100
        pa = res.get('away_win_probability', 0) * 100
        src = res.get('ai_source', '?')
        f.write(f"{h} vs {a}\n")
        f.write(f"  Score: {sc}  |  xG: {xgh:.2f}-{xga:.2f}  |  H/D/A: {ph}/{pd_}/{pa}  |  Source: {src}\n\n")
