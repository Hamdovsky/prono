import json
import sqlite3
from prediction_engine import analyze_match_pro

db_path = 'data/tactical.db'
conn = sqlite3.connect(db_path)
cur = conn.cursor()

# Get one match
cur.execute("SELECT fullData FROM matches WHERE status='scheduled' LIMIT 1")
row = cur.fetchone()
if not row:
    print("No matches found")
    exit()

match_data = json.loads(row[0])
print(f"Testing match: {match_data.get('homeTeam')} vs {match_data.get('awayTeam')}")

try:
    result = analyze_match_pro(match_data)
    print("PREDICTION RESULT:")
    print(json.dumps(result, indent=2))
except Exception as e:
    print(f"ERROR: {e}")

conn.close()
