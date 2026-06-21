import sqlite3
import os

def inspect_db(db_path, f):
    if not os.path.exists(db_path):
        f.write(f"Database not found: {db_path}\n")
        return
    f.write(f"\n--- Inspecting: {db_path} ---\n")
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = cursor.fetchall()
    for table in tables:
        table_name = table[0]
        f.write(f"\nTable: {table_name}\n")
        cursor.execute(f"PRAGMA table_info({table_name})")
        columns = cursor.fetchall()
        for col in columns:
            f.write(f" - {col[1]} ({col[2]})\n")
    conn.close()

if __name__ == "__main__":
    with open('db_schemas.txt', 'w', encoding='utf-8') as f:
        inspect_db(r'c:\Users\HAMDI\Desktop\stitch\data\historical_archive.sqlite', f)
        inspect_db(r'c:\Users\HAMDI\Desktop\stitch\data\tactical.db', f)
        inspect_db(r'c:\Users\HAMDI\Desktop\stitch\tactical.db', f)
    print("Schemas written to db_schemas.txt")
