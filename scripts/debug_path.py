import sqlite3
import os

db_path = 'data/historical_archive.sqlite'
abs_path = os.path.abspath(db_path)
conn = sqlite3.connect(abs_path)
cursor = conn.cursor()

cursor.execute("SELECT COUNT(*) FROM archive_matches")
count = cursor.fetchone()[0]
print(f"Path: {abs_path}")
print(f"archive_matches count: {count}")

cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
print(f"Tables: {[t[0] for t in cursor.fetchall()]}")

conn.close()
