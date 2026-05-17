import sqlite3

with open('status_out.txt', 'w', encoding='utf-8') as f:
    conn = sqlite3.connect('data/historical_archive.sqlite')
    rows = conn.execute("SELECT status, COUNT(*) as cnt FROM archive_matches WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL AND stats_blob IS NOT NULL GROUP BY status ORDER BY cnt DESC").fetchall()
    conn.close()
    for r in rows:
        f.write(f"Status: '{r[0]}' | Count: {r[1]}\n")
