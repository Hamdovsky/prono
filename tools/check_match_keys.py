import sqlite3
import json

with open('match_keys_out.txt', 'w', encoding='utf-8') as f:
    conn = sqlite3.connect('data/tactical.db')
    cur = conn.cursor()
    cur.execute("SELECT fullData FROM matches WHERE status='scheduled' LIMIT 2")
    rows = cur.fetchall()
    for row in rows:
        match_data = json.loads(row[0])
        f.write("=== MATCH KEYS ===\n")
        for k, v in match_data.items():
            if k not in ['stats_blob', 'news_data', 'fullData']:  # skip heavy blobs
                f.write(f"  {k}: {str(v)[:120]}\n")
        f.write("\n")
