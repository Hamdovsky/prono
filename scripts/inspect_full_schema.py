import sqlite3
import os

def inspect_db(db_path):
    if not os.path.exists(db_path):
        print(f"Database not found: {db_path}")
        return
    print(f"\n--- Inspecting: {db_path} ---")
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = cursor.fetchall()
    for table in tables:
        table_name = table[0]
        print(f"\nTable: {table_name}")
        cursor.execute(f"PRAGMA table_info({table_name})")
        columns = cursor.fetchall()
        for col in columns:
            print(f" - {col[1]} ({col[2]})")
    conn.close()

if __name__ == "__main__":
    inspect_db(r'c:\Users\HAMDI\Desktop\stitch\data\historical_archive.sqlite')
    inspect_db(r'c:\Users\HAMDI\Desktop\stitch\data\tactical.db')
    inspect_db(r'c:\Users\HAMDI\Desktop\stitch\tactical.db')
