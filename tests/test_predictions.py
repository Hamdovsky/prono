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
        h = match_data.get('homeTeam', '?')
        a = match_data.get('awayTeam', '?')
        sc = res['metrics']['expected_score']
        xgh = res['metrics']['raw_xg_h']
        xga = res['metrics']['raw_xg_a']
        ph = res['metrics']['home_win_probability']
        pd_ = res['metrics']['draw_probability']
        pa = res['metrics']['away_win_probability']
        src = res['ai_source']
        f.write(f"{h} vs {a}\n")
        f.write(f"  Score: {sc}  |  xG: {xgh:.2f}-{xga:.2f}  |  H/D/A: {ph}/{pd_}/{pa}  |  Source: {src}\n\n")
