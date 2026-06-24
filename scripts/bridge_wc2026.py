"""Bridge wc2026_matches -> archive_matches so WC data flows through the main ML pipeline."""
import sqlite3, os, json, time, sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(BASE, 'data', 'historical_archive.sqlite')

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

# Read source matches that have actual scores
rows = conn.execute("""
    SELECT * FROM wc2026_matches 
    WHERE score_ft_home IS NOT NULL 
      AND score_ft_away IS NOT NULL
    ORDER BY match_date
""").fetchall()

inserted = 0
skipped = 0

for r in rows:
    home = (r['team1'] or '').strip()
    away = (r['team2'] or '').strip()
    score_h = r['score_ft_home']
    score_a = r['score_ft_away']
    match_date = r['match_date'] or ''
    group_name = r['group_name'] or ''

    # Build tournament name
    tourn = 'World Cup 2026'
    if group_name:
        tourn = f'World Cup 2026 - {group_name}'

    # Determine result
    if score_h > score_a:
        result = 'H'
    elif score_h == score_a:
        result = 'D'
    else:
        result = 'A'

    # Parse match_date to timestamp
    ts = 0
    try:
        if match_date:
            dt = time.strptime(match_date, '%Y-%m-%d')
            ts = int(time.mktime(dt))
    except:
        ts = 0

    # Check if already exists
    existing = conn.execute(
        "SELECT id FROM archive_matches WHERE homeTeam = ? AND awayTeam = ? AND startTimestamp = ?",
        (home, away, ts)
    ).fetchone()

    if existing:
        skipped += 1
        continue

    conn.execute("""
        INSERT OR IGNORE INTO archive_matches
        (homeTeam, awayTeam, tournament_name, league, scoreHome, scoreAway, 
         status, startTimestamp, match_date, result, archived_at)
        VALUES (?, ?, ?, ?, ?, ?, 'finished', ?, ?, ?, ?)
    """, (
        home, away, tourn, 'World Cup 2026',
        int(score_h), int(score_a),
        ts, match_date, result,
        int(time.time())
    ))
    inserted += 1

conn.commit()
print(f'Bridge complete: {inserted} inserted, {skipped} already existed')
conn.close()
