"""
Populate historical_archive.sqlite from tactical.db historical_matches fullData JSON.
Also pulls finished matches from Render PostgreSQL via the API.
"""
import sqlite3
import json
import os
import sys
import time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
ARCHIVE_PATH = os.path.join(BASE_DIR, 'data', 'historical_archive.sqlite')
TACTICAL_PATH = os.path.join(BASE_DIR, 'data', 'tactical.db')

EXPECTED_COLS = [
    'sofascore_id', 'homeTeam', 'awayTeam', 'tournament_name', 'league',
    'scoreHome', 'scoreAway', 'status', 'startTimestamp',
    'odds_home', 'odds_draw', 'odds_away',
    'home_xg', 'away_xg',
    'stats_blob', 'h2h_data', 'odds_movement_24h',
    'player_ratings_home', 'player_ratings_away',
]

def ensure_schema(conn):
    """Drop and recreate archive_matches with proper columns."""
    c = conn.cursor()
    c.execute('DROP TABLE IF EXISTS archive_matches')
    c.execute('''
        CREATE TABLE archive_matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sofascore_id INTEGER UNIQUE,
            homeTeam TEXT,
            awayTeam TEXT,
            tournament_name TEXT,
            league TEXT,
            scoreHome INTEGER,
            scoreAway INTEGER,
            status TEXT,
            startTimestamp INTEGER,
            odds_home REAL,
            odds_draw REAL,
            odds_away REAL,
            home_xg REAL,
            away_xg REAL,
            stats_blob TEXT,
            h2h_data TEXT,
            odds_movement_24h TEXT,
            player_ratings_home TEXT,
            player_ratings_away TEXT,
            historical_context TEXT,
            form_context TEXT,
            match_date TEXT,
            result TEXT,
            archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()
    print('[SCHEMA] archive_matches recreated with full column set')

def populate_from_tactical():
    """Read tactical.db historical_matches and insert into archive."""
    print(f'\n[SOURCE] Reading tactical.db historical_matches...')
    src = sqlite3.connect(TACTICAL_PATH)
    src.row_factory = sqlite3.Row
    count = src.execute('SELECT COUNT(*) FROM historical_matches').fetchone()[0]
    print(f'  Total historical_matches: {count}')

    rows = src.execute('SELECT * FROM historical_matches ORDER BY timestamp ASC').fetchall()
    src.close()

    dst = sqlite3.connect(ARCHIVE_PATH)
    ensure_schema(dst)
    cur = dst.cursor()

    inserted = 0
    skipped = 0
    for r in rows:
        try:
            fd = json.loads(r['fullData']) if r['fullData'] and r['fullData'] != '{}' else {}
        except (json.JSONDecodeError, TypeError):
            fd = {}

        # Prefer score from fullData, fallback to top-level columns
        score_obj = fd.get('score', {})
        home_score = score_obj.get('home') if isinstance(score_obj, dict) else None
        away_score = score_obj.get('away') if isinstance(score_obj, dict) else None

        if home_score is None:
            home_score = r['scoreHome']
        if away_score is None:
            away_score = r['scoreAway']

        if home_score is None or away_score is None:
            skipped += 1
            continue

        sofascore_id = r['id']
        if isinstance(sofascore_id, str) and sofascore_id.isdigit():
            sofascore_id = int(sofascore_id)
        elif isinstance(sofascore_id, str):
            try:
                sofascore_id = int(''.join(c for c in sofascore_id if c.isdigit())[:10])
            except (ValueError, IndexError):
                sofascore_id = None

        home_team = fd.get('homeTeam') or r['homeTeam'] or 'Unknown'
        away_team = fd.get('awayTeam') or r['awayTeam'] or 'Unknown'
        league = r['league'] or fd.get('tournament_name') or fd.get('league') or 'Unknown'
        tournament = fd.get('tournament_name') or league

        start_ts = fd.get('startTimestamp') or 0
        if isinstance(start_ts, str):
            try:
                start_ts = int(start_ts)
            except ValueError:
                start_ts = 0

        try:
            cur.execute('''
                INSERT OR IGNORE INTO archive_matches
                    (sofascore_id, homeTeam, awayTeam, tournament_name, league,
                     scoreHome, scoreAway, status, startTimestamp,
                     odds_home, odds_draw, odds_away,
                     home_xg, away_xg, stats_blob, h2h_data, odds_movement_24h)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ''', (
                sofascore_id,
                home_team, away_team,
                tournament, league,
                home_score or 0, away_score or 0,
                fd.get('status', 'FT'),
                start_ts,
                fd.get('odds_home'), fd.get('odds_draw'), fd.get('odds_away'),
                fd.get('home_xg'), fd.get('away_xg'),
                json.dumps(fd.get('stats', [])),
                fd.get('h2h_data'), fd.get('odds_movement_24h'),
            ))
            inserted += cur.rowcount or 0
        except Exception as e:
            skipped += 1

        if inserted % 200 == 0 and inserted > 0:
            print(f'  ... Inserted {inserted} rows')

    dst.commit()
    dst.close()
    print(f'[DONE] tactical.db: {inserted} inserted, {skipped} skipped')
    return inserted

def populate_from_tactical_matches():
    """Add finished matches from tactical.db matches table."""
    print(f'\n[SOURCE] Reading tactical.db matches (finished)...')
    src = sqlite3.connect(TACTICAL_PATH)
    src.row_factory = sqlite3.Row
    rows = src.execute(
        "SELECT * FROM matches WHERE status IN ('FT', 'finished', 'Finished', 'Ended') AND scoreHome IS NOT NULL AND scoreAway IS NOT NULL"
    ).fetchall()
    src.close()
    print(f'  Finished matches: {len(rows)}')

    dst = sqlite3.connect(ARCHIVE_PATH)
    cur = dst.cursor()
    inserted = 0

    for r in rows:
        try:
            fd = {}
            try:
                if r['fullData'] and r['fullData'] != '{}':
                    fd = json.loads(r['fullData'])
            except (json.JSONDecodeError, TypeError):
                fd = {}

            existing = cur.execute(
                'SELECT id FROM archive_matches WHERE homeTeam = ? AND awayTeam = ? AND scoreHome = ? AND scoreAway = ?',
                (r['homeTeam'], r['awayTeam'], r['scoreHome'], r['scoreAway'])
            ).fetchone()
            if existing:
                continue

            sofascore_id = r['id']
            if isinstance(sofascore_id, str) and sofascore_id.isdigit():
                sofascore_id = int(sofascore_id)
            elif isinstance(sofascore_id, str):
                try:
                    sofascore_id = int(''.join(c for c in sofascore_id if c.isdigit())[:10])
                except (ValueError, IndexError):
                    sofascore_id = None

            cur.execute('''
                INSERT OR IGNORE INTO archive_matches
                    (sofascore_id, homeTeam, awayTeam, tournament_name, league,
                     scoreHome, scoreAway, status, startTimestamp,
                     odds_home, odds_draw, odds_away,
                     home_xg, away_xg, stats_blob)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ''', (
                sofascore_id,
                r['homeTeam'], r['awayTeam'],
                r.get('tournament_name') or r['league'],
                r['league'],
                r['scoreHome'], r['scoreAway'],
                r.get('status', 'FT'),
                r.get('startTimestamp') or fd.get('startTimestamp'),
                fd.get('odds_home') or r.get('odds_home'),
                fd.get('odds_draw') or r.get('odds_draw'),
                fd.get('odds_away') or r.get('odds_away'),
                fd.get('home_xg') or r.get('home_xg'),
                fd.get('away_xg') or r.get('away_xg'),
                json.dumps(fd.get('stats', [])),
            ))
            inserted += cur.rowcount or 0
        except Exception:
            pass

    dst.commit()
    dst.close()
    print(f'  Inserted: {inserted}')
    return inserted

if __name__ == '__main__':
    print('=' * 60)
    print('  Populate historical_archive.sqlite')
    print('=' * 60)

    total = 0
    total += populate_from_tactical()
    total += populate_from_tactical_matches()

    # Verify
    conn = sqlite3.connect(ARCHIVE_PATH)
    c = conn.cursor()
    total_rows = c.execute('SELECT COUNT(*) FROM archive_matches').fetchone()[0]
    with_scores = c.execute('SELECT COUNT(*) FROM archive_matches WHERE scoreHome IS NOT NULL').fetchone()[0]
    with_odds = c.execute('SELECT COUNT(*) FROM archive_matches WHERE odds_home IS NOT NULL').fetchone()[0]
    conn.close()

    print(f'\n{"=" * 60}')
    print(f'  FINAL: {total_rows} total rows in archive_matches')
    print(f'  With scores: {with_scores}')
    print(f'  With odds: {with_odds}')
    print(f'  Newly inserted this run: {total}')
    print(f'{"=" * 60}')
