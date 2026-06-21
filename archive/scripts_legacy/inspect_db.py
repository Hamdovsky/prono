import sqlite3
import json
import os

DB_PATH = 'data/historical_archive.sqlite'

def inspect():
    if not os.path.exists(DB_PATH):
        print(f"Error: {DB_PATH} not found.")
        return

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # List tables
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
    tables = cursor.fetchall()
    print("Tables:", tables)

    for table_info in tables:
        table_name = table_info[0]
        print(f"\nSchema for {table_name}:")
        cursor.execute(f"PRAGMA table_info({table_name});")
        print(cursor.fetchall())

        print(f"\nSample row from {table_name}:")
        cursor.execute(f"SELECT * FROM {table_name} LIMIT 1;")
        row = cursor.fetchone()
        if row:
            columns = [description[0] for description in cursor.description]
            sample = dict(zip(columns, row))
            # If stats_blob is in the row, try to parse it
            if 'stats_blob' in sample and sample['stats_blob']:
                try:
                    sample['stats_blob_parsed'] = json.loads(sample['stats_blob'])[:2] # Only show first 2 items
                except:
                    pass
            print(sample)

    conn.close()

if __name__ == "__main__":
    inspect()
