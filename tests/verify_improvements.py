import json
import sqlite3
import os
from prediction_engine import analyze_match_pro

DB_PATH = os.path.join(os.path.dirname(__file__), 'data', 'historical_archive.sqlite')

def verify():
    if not os.path.exists(DB_PATH):
        print("Database not found.")
        return

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # Get a recent match
    row = conn.execute("SELECT * FROM archive_matches WHERE stats_blob IS NOT NULL ORDER BY id DESC LIMIT 1").fetchone()
    conn.close()
    
    if not row:
        print("No match found for verification.")
        return

    match_data = dict(row)
    print(f"Verifying Match: {match_data.get('homeTeam')} vs {match_data.get('awayTeam')}")
    
    result = analyze_match_pro(match_data)
    print("\n--- Prediction Results ---")
    print(json.dumps(result, indent=2))
    
    if result.get('success'):
        print("\n✅ Verification Successful: Hybrid model is yielding results.")
    else:
        print("\n❌ Verification Failed.")

if __name__ == "__main__":
    verify()
