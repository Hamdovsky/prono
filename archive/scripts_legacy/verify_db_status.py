import sqlite3
import json

DB_PATH = r"c:\Users\HAMDI\Desktop\stitch\data\tactical.db"

def check_results():
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        
        # Look for Leverkusen or Arsenal match
        query = "SELECT id, homeTeam, awayTeam, expected_score, xgboost_confidence, fullData FROM matches WHERE homeTeam LIKE '%Leverkusen%' OR homeTeam LIKE '%Arsenal%'"
        cur.execute(query)
        rows = cur.fetchall()
        
        print(f"Found {len(rows)} matches.")
        for row in rows:
            print("-" * 50)
            print(f"Match: {row['homeTeam']} vs {row['awayTeam']} (ID: {row['id']})")
            print(f"SQL Columns: expected_score={row['expected_score']}, confidence={row['xgboost_confidence']}")
            
            try:
                data = json.loads(row['fullData'])
                print(f"JSON fullData: expected_score={data.get('expected_score')}, confidence={data.get('xgboost_confidence')}")
            except Exception as e:
                print(f"Error parsing JSON: {e}")
                
    except Exception as e:
        print(f"Database error: {e}")
    finally:
        if 'conn' in locals():
            conn.close()

if __name__ == "__main__":
    check_results()
