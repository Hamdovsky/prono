import sqlite3
import json
import os

DB_ARCHIVE_PATH = r'c:\Users\HAMDI\Desktop\stitch\data\historical_archive.sqlite'

def inspect_context():
    if not os.path.exists(DB_ARCHIVE_PATH):
        print("Database not found.")
        return

    conn = sqlite3.connect(DB_ARCHIVE_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT historical_context, form_context FROM archive_matches WHERE historical_context IS NOT NULL LIMIT 1")
    row = cursor.fetchone()
    if row:
        print("Historical Context Sample:")
        print(json.dumps(json.loads(row[0]), indent=2))
        print("\nForm Context Sample:")
        print(json.dumps(json.loads(row[1]), indent=2))
    conn.close()

if __name__ == "__main__":
    inspect_context()
