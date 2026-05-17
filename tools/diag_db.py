import sqlite3
import collections

db_path = 'data/tactical.db'
conn = sqlite3.connect(db_path)
cur = conn.cursor()

# Check distribution of expected_score
cur.execute("SELECT expected_score, COUNT(*) FROM matches WHERE status = 'scheduled' GROUP BY expected_score")
dist = cur.fetchall()

print("Distribution of scheduled match scores:")
for score, count in sorted(dist, key=lambda x: x[1], reverse=True):
    print(f"  {score}: {count}")

# Check sample detailed data
print("\nSample matches with non 1-1 scores:")
cur.execute("SELECT homeTeam, awayTeam, expected_score, xgboost_prediction_data FROM matches WHERE expected_score != '1 - 1' AND expected_score IS NOT NULL LIMIT 5")
for row in cur.fetchall():
    print(f"  {row[0]} vs {row[1]}: {row[2]}")

conn.close()
