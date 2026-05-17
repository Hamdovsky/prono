import sqlite3
import json
import os

DB_PATH = r"c:\Users\HAMDI\Desktop\stitch\data\tactical.db"

def check_db():
    if not os.path.exists(DB_PATH):
        print(f"Error: Database not found at {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    print("--- Checking Top 5 Upcoming/Live matches with missing scores ---")
    query = """
        SELECT id, homeTeam, awayTeam, expected_score, xgboost_confidence, status, last_updated 
        FROM matches 
        WHERE (expected_score = '? - ?' OR expected_score IS NULL)
        AND status IN ('scheduled', 'live')
        LIMIT 5
    """
    cur.execute(query)
    rows = cur.fetchall()
    for r in rows:
        print(f"ID: {r['id']} | {r['homeTeam']} vs {r['awayTeam']} | Score: {r['expected_score']} | Status: {r['status']} | LastUpdated: {r['last_updated']}")

    print("\n--- Checking Leverkusen Match Specifically ---")
    query = """
        SELECT id, homeTeam, awayTeam, expected_score, xgboost_confidence, status, last_updated 
        FROM matches 
        WHERE homeTeam LIKE '%Leverkusen%' OR awayTeam LIKE '%Leverkusen%'
    """
    cur.execute(query)
    rows = cur.fetchall()
    for r in rows:
        print(f"ID: {r['id']} | {r['homeTeam']} vs {r['awayTeam']} | Score: {r['expected_score']} | Status: {r['status']}")

    conn.close()

if __name__ == "__main__":
    check_db()
