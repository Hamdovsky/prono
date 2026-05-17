import sqlite3
import collections

conn = sqlite3.connect('data/historical_archive.sqlite')
conn.row_factory = sqlite3.Row
query = """
SELECT scoreHome, scoreAway FROM archive_matches 
WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL 
AND stats_blob IS NOT NULL
LIMIT 3000
"""
rows = conn.execute(query).fetchall()
conn.close()

targets = []
for r in rows:
    sh, sa = r['scoreHome'], r['scoreAway']
    if sh > sa: target = 2 # Home
    elif sh < sa: target = 0 # Away
    else: target = 1 # Draw
    targets.append(target)

counts = collections.Counter(targets)
print("Distribution:", counts)
