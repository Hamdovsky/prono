import sqlite3
import json
import os

DB_PATH = r"c:\Users\HAMDI\Desktop\stitch\data\tactical.db"
OUTPUT = r"c:\Users\HAMDI\Desktop\stitch\scripts\debug_matches_output.txt"

teams = [
    'Leverkusen', 'Arsenal', 'Sporting CP', 'Bodglimt', 
    'Paris Saint-germain', 'Chelsea', 'Real Madrid', 'Manchester City'
]

def check_matches():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    
    conditions = " OR ".join([f"homeTeam LIKE '%{t}%' OR awayTeam LIKE '%{t}%'" for t in teams])
    query = f"SELECT id, homeTeam, awayTeam, expected_score, status, fullData FROM matches WHERE ({conditions}) AND status != 'FT'"
    
    cur.execute(query)
    rows = cur.fetchall()
    
    with open(OUTPUT, "w", encoding="utf-8") as f:
        for r in rows:
            match_id = r['id']
            home = r['homeTeam']
            away = r['awayTeam']
            score = r['expected_score']
            
            insufficient = False
            news_len = 0
            
            try:
                fd = json.loads(r['fullData'])
                insufficient = fd.get('insufficient_data', False)
                news = fd.get('news_data', {})
                if 'home_headlines' in news: news_len += len(news['home_headlines'])
                if 'away_headlines' in news: news_len += len(news['away_headlines'])
            except Exception as e:
                f.write(f"Error parsing fully_data for {match_id}: {e}\n")
                
            f.write(f"[{match_id}] {home} vs {away} | Score: {score} | Insufficient Data: {insufficient} | Headlines: {news_len}\n")
        f.write("\nDone.")
    conn.close()

if __name__ == "__main__":
    check_matches()
