import sqlite3
import os
import json

DB_ARCHIVE = r"c:\Users\HAMDI\Desktop\stitch\data\historical_archive.sqlite"
DB_LIVE = r"c:\Users\HAMDI\Desktop\stitch\data\tactical.db" # Wait, check where live matches are

def check_db(db_path, query, params=()):
    if not os.path.exists(db_path):
        print(f"File not found: {db_path}")
        return
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(query, params).fetchall()
        for r in rows:
            print(dict(r))
    except Exception as e:
        print(f"Error: {e}")
    finally:
        conn.close()

print("\n--- Checking matches for Leverkusen/Arsenal in tactical.db ---")
check_db(DB_LIVE, "SELECT homeTeam, awayTeam, expected_score, xgboost_confidence, status FROM matches WHERE homeTeam LIKE '%Leverkusen%' OR awayTeam LIKE '%Leverkusen%' OR homeTeam LIKE '%Arsenal%' LIMIT 10")
