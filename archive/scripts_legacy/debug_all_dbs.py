import sqlite3
import os
import glob

# Search root and data directory
db_files = glob.glob('**/*.sqlite', recursive=True) + glob.glob('**/*.db', recursive=True)

for db in set(db_files):
    print(f"--- Database: {db} ---")
    try:
        conn = sqlite3.connect(db)
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = cursor.fetchall()
        for table in tables:
            t_name = table[0]
            cursor.execute(f"SELECT COUNT(*) FROM {t_name}")
            count = cursor.fetchone()[0]
            print(f"  Table: {t_name} | Rows: {count}")
            
            # Check for stats column
            cursor.execute(f"PRAGMA table_info({t_name})")
            cols = [c[1] for c in cursor.fetchall()]
            stats_cols = [c for c in cols if 'stats' in c.lower() or 'fullData' in c or 'data' in c.lower()]
            if stats_cols:
                print(f"    Possible stats columns: {stats_cols}")
        conn.close()
    except Exception as e:
        print(f"  Error: {e}")
    print()
