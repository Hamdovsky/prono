import sqlite3
import os

db_path = 'data/tactical.db'
if not os.path.exists(db_path):
    print(f"Error: {db_path} not found")
else:
    conn = sqlite3.connect(db_path)
    count = conn.execute("SELECT COUNT(*) FROM player_stats").fetchone()[0]
    print(f"Total players in player_stats: {count}")
    if count > 0:
        sample = conn.execute("SELECT * FROM player_stats LIMIT 3").fetchall()
        print("Sample data:")
        for row in sample:
            print(row)
    conn.close()
