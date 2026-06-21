import sqlite3
import os

dbs = ['database.sqlite', 'titanium_tactical.db', 'app.db']

for db in dbs:
    if not os.path.exists(db):
        print(f"File {db} does not exist.\n")
        continue

    print(f"Checking database: {db}")
    conn = sqlite3.connect(db)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = cursor.fetchall()
    for table in tables:
        table_name = table[0]
        cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
        count = cursor.fetchone()[0]
        print(f"  {table_name}: {count} rows")
    conn.close()
    print()
