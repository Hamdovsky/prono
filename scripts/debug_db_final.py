import sqlite3
import os

db_path = 'data/historical_archive.sqlite'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

print(f"Checking {db_path}...")
cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [t[0] for t in cursor.fetchall()]
for t in tables:
    cursor.execute(f"SELECT COUNT(*) FROM {t}")
    total = cursor.fetchone()[0]
    print(f"  Table: {t}, Total rows: {total}")
    
    cursor.execute(f"PRAGMA table_info({t})")
    cols = [c[1] for c in cursor.fetchall()]
    if 'stats_blob' in cols:
        cursor.execute(f"SELECT COUNT(*) FROM {t} WHERE stats_blob IS NOT NULL AND stats_blob != ''")
        valid = cursor.fetchone()[0]
        print(f"    -> Rows with stats_blob: {valid}")
    if 'stats_json' in cols:
        cursor.execute(f"SELECT COUNT(*) FROM {t} WHERE stats_json IS NOT NULL AND stats_json != ''")
        valid = cursor.fetchone()[0]
        print(f"    -> Rows with stats_json: {valid}")

conn.close()
