import sqlite3
import json
import os

db_path = 'data/tactical.db'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

cursor.execute("SELECT fullData FROM matches")
rows = cursor.fetchall()

count_with_stats = 0
for row in rows:
    try:
        data = json.loads(row[0])
        if data.get('statistics') and len(data['statistics']) > 0:
            count_with_stats += 1
    except:
        continue

print(f"Matches with statistics in tactical.db: {count_with_stats}")
conn.close()
