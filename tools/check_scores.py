import sqlite3

with open('scores_out.txt', 'w', encoding='utf-8') as f:
    conn = sqlite3.connect('data/historical_archive.sqlite')
    conn.row_factory = sqlite3.Row
    query = "SELECT homeTeam, awayTeam, scoreHome, scoreAway, status FROM archive_matches WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL AND stats_blob IS NOT NULL LIMIT 40"
    rows = conn.execute(query).fetchall()
    conn.close()

    for r in rows:
        f.write(f"{r['homeTeam']} vs {r['awayTeam']} | {r['scoreHome']} - {r['scoreAway']} ({r['status']})\n")
