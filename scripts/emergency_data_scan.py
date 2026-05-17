import sqlite3
import os
import glob
import json

db_files = glob.glob('**/*.sqlite', recursive=True) + glob.glob('**/*.db', recursive=True)

for db in set(db_files):
    if 'brain' in db or '.gemini' in db: continue
    print(f"Checking: {db}")
    try:
        conn = sqlite3.connect(db)
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [t[0] for t in cursor.fetchall()]
        for t in tables:
            cursor.execute(f"PRAGMA table_info({t})")
            cols = [c[1] for c in cursor.fetchall()]
            
            # Look for JSON/Blob columns
            json_cols = [c for c in cols if 'stats' in c.lower() or 'json' in c.lower() or 'blob' in c.lower() or 'full' in c.lower()]
            if json_cols:
                cursor.execute(f"SELECT COUNT(*) FROM {t}")
                total = cursor.fetchone()[0]
                
                # Check how many have non-null/non-empty data
                valid_count = 0
                for jc in json_cols:
                    cursor.execute(f"SELECT COUNT(*) FROM {t} WHERE {jc} IS NOT NULL AND {jc} != '' AND {jc} != '[]' AND {jc} != '{{}}'")
                    valid_count = max(valid_count, cursor.fetchone()[0])
                
                print(f"  -> Table '{t}': {total} rows, {valid_count} with data in columns {json_cols}")
        conn.close()
    except Exception as e:
        print(f"  Error: {e}")
    print("-" * 20)
