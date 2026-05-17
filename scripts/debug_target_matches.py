import sqlite3
import json
import os

DB_PATH = r"c:\Users\HAMDI\Desktop\stitch\data\tactical.db"

targeted_teams = [
    'Leverkusen', 'Arsenal', 'Sporting', 'Bodglimt', 
    'Paris', 'Chelsea', 'Real Madrid', 'Manchester City'
]

def check_targeted_matches():
    if not os.path.exists(DB_PATH):
        print(f"Error: DB not found at {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Build the WHERE clause dynamically
    conditions = " OR ".join([f"homeTeam LIKE '%{team}%' OR awayTeam LIKE '%{team}%'" for team in targeted_teams])
    query = f"SELECT id, homeTeam, awayTeam, expected_score, xgboost_confidence, status, last_updated, fullData FROM matches WHERE ({conditions}) AND status != 'FT'"
    
    cur.execute(query)
    rows = cur.fetchall()
    
    print(f"Found {len(rows)} targeted matches.")
    for row in rows:
        print("="*60)
        print(f"ID: {row['id']}")
        print(f"Match: {row['homeTeam']} vs {row['awayTeam']}")
        print(f"Status: {row['status']}")
        print(f"SQL Score: {row['expected_score']}")
        print(f"SQL Conf : {row['xgboost_confidence']}")
        print(f"Updated  : {row['last_updated']}")
        
        try:
            full_data = json.loads(row['fullData'])
            print(f"JSON Score: {full_data.get('expected_score')}")
            print(f"JSON Conf : {full_data.get('xgboost_confidence')}")
        except:
            print("JSON parsing failed")
    
    conn.close()

if __name__ == "__main__":
    check_targeted_matches()
