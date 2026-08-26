"""Apply HT + corners columns migration to matches table (idempotent)."""
import sqlite3
import os

DB_PATHS = [
    "data/tactical.db",
    "data/predictions.db",
]
COLUMNS = [
    ("ht_score_home", "INTEGER"),
    ("ht_score_away", "INTEGER"),
    ("corners_ht_home", "INTEGER"),
    ("corners_ht_away", "INTEGER"),
]
for db_path in DB_PATHS:
    if not os.path.exists(db_path):
        print(f"[SKIP] {db_path} (missing)")
        continue
    db = sqlite3.connect(db_path)
    cur = db.cursor()
    cur.execute('PRAGMA table_info(matches)')
    existing = {r[1] for r in cur.fetchall()}
    n = 0
    for col, typedef in COLUMNS:
        if col not in existing:
            cur.execute(f"ALTER TABLE matches ADD COLUMN {col} {typedef}")
            print(f"  + {db_path}: matches.{col} {typedef}")
            n += 1
    db.commit()
    db.close()
    if n == 0:
        print(f"[OK] {db_path} schema already up-to-date")
