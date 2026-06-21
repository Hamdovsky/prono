import sqlite3
db_path = 'data/tactical.db'
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute('SELECT expected_score, COUNT(*) FROM matches WHERE status="scheduled" GROUP BY expected_score ORDER BY COUNT(*) DESC')
dist = cur.fetchall()
print("-- SCORE DISTRIBUTION --")
for score, count in dist:
    print(f"  {score}: {count}")
conn.close()
