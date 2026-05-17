import sqlite3
import json
from prediction_engine import process_prediction

DB_PATH = r"c:\Users\HAMDI\Desktop\stitch\data\tactical.db"

def test_bridge():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM matches WHERE id=15631363")
    row = cur.fetchone()
    conn.close()

    if not row:
        print("Match not found")
        return

    match = dict(row)
    # simulate predict_bridge.py
    full_data = match.get('fullData', {})
    if isinstance(full_data, str):
        try: full_data = json.loads(full_data)
        except: full_data = {}

    if isinstance(full_data, dict):
        for k, v in full_data.items():
            if k not in match: match[k] = v
            
    # Also enriched_predictions.js adds history 
    # Let's see process_prediction
    result = process_prediction(match)
    print("Match:", match['homeTeam'], "vs", match['awayTeam'])
    print("Result:", json.dumps(result, indent=2))

if __name__ == "__main__":
    test_bridge()
