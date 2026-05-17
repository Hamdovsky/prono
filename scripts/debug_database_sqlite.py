import sqlite3
import os

db_path = 'database.sqlite'
if not os.path.exists(db_path):
    print(f"File {db_path} does not exist.")
    exit(1)

conn = sqlite3.connect(db_path)
print(f"Connected to {db_path}")
cursor = conn.cursor()

cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = cursor.fetchall()
print(f"Tables: {tables}")

for table in tables:
    t_name = table[0]
    print(f"\nSchema for {t_name}:")
    cursor.execute(f"PRAGMA table_info({t_name})")
    for col in cursor.fetchall():
        print(f"  {col}")
    
    cursor.execute(f"SELECT * FROM {t_name} LIMIT 1")
    row = cursor.fetchone()
    print(f"  Sample row: {row}")

conn.close()
