import sqlite3
import os

tactical_db = 'data/tactical.db'
archive_db = 'data/historical_archive.sqlite'

conn_t = sqlite3.connect(tactical_db)
conn_a = sqlite3.connect(archive_db)

cur_t = conn_t.cursor()
cur_a = conn_a.cursor()

# Get 20 scheduled teams
cur_t.execute("SELECT homeTeam, awayTeam FROM matches WHERE status='scheduled' LIMIT 20")
matches = cur_t.fetchall()

print(f"{'Team Name':<30} | {'Exact Match':<12} | {'Fuzzy Match (%)'}")
print("-" * 60)

for h, a in matches:
    for team in [h, a]:
        # Exact
        cur_a.execute("SELECT COUNT(*) FROM archive_matches WHERE homeTeam = ? OR awayTeam = ?", (team, team))
        exact = cur_a.fetchone()[0]
        
        # Fuzzy %team%
        cur_a.execute("SELECT COUNT(*) FROM archive_matches WHERE homeTeam LIKE ? OR awayTeam LIKE ?", (f"%{team}%", f"%{team}%"))
        fuzzy = cur_a.fetchone()[0]
        
        print(f"{team:<30} | {exact:<12} | {fuzzy}")

conn_t.close()
conn_a.close()
