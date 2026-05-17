import sqlite3
import os

DB_ARCHIVE_PATH = r'c:\Users\HAMDI\Desktop\stitch\data\historical_archive.sqlite'

def check_schema():
    if not os.path.exists(DB_ARCHIVE_PATH):
        print("Database not found.")
        return

    conn = sqlite3.connect(DB_ARCHIVE_PATH)
    cursor = conn.cursor()
    cursor.execute("PRAGMA table_info(archive_matches)")
    columns = cursor.fetchall()
    print("Columns in archive_matches:")
    for col in columns:
        print(f" - {col[1]} ({col[2]})")
    conn.close()

if __name__ == "__main__":
    check_schema()
