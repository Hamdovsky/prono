import sqlite3
import os
import json

DB_ARCHIVE_PATH = r'c:\Users\HAMDI\Desktop\stitch\data\historical_archive.sqlite'

def inspect():
    if not os.path.exists(DB_ARCHIVE_PATH):
        print(f"Database not found at {DB_ARCHIVE_PATH}")
        return

    conn = sqlite3.connect(DB_ARCHIVE_PATH)
    cursor = conn.cursor()
    
    # Check schema
    cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='archive_matches'")
    schema = cursor.fetchone()
    print("Schema for archive_matches:")
    print(schema[0] if schema else "Table not found")
    
    # Check for xG in stats_blob
    cursor.execute("SELECT stats_blob FROM archive_matches WHERE stats_blob IS NOT NULL LIMIT 20")
    rows = cursor.fetchall()
    
    found_xg = False
    for i, row in enumerate(rows):
        stats = json.loads(row[0])
        for item in stats:
            cat = item.get('category', '').lower()
            if 'expected' in cat or 'xg' in cat:
                print(f"Found xG-like stat: {item}")
                found_xg = True
    
    if not found_xg:
        print("No explicit xG found in samples.")
        # Print one sample of stats to see what we have
        if rows:
            print("Sample stats structure:")
            print(json.dumps(json.loads(rows[0][0])[:5], indent=2))

    conn.close()

if __name__ == "__main__":
    inspect()
