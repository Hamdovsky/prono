import sqlite3, json
conn = sqlite3.connect('data/historical_archive.sqlite')
conn.row_factory = sqlite3.Row

row = conn.execute('SELECT stats_blob FROM archive_matches WHERE stats_blob IS NOT NULL LIMIT 1').fetchone()
sb = json.loads(row['stats_blob'])
print('stats_blob type:', type(sb).__name__)
if isinstance(sb, list) and sb:
    print('  List items:', len(sb))
    if isinstance(sb[0], dict):
        print('  Sample keys:', list(sb[0].keys()))
elif isinstance(sb, dict):
    print('  Dict keys:', list(sb.keys()))

with_ts = conn.execute('SELECT COUNT(*) FROM archive_matches WHERE teamStats IS NOT NULL').fetchone()[0]
with_odds = conn.execute('SELECT COUNT(*) FROM archive_matches WHERE odds_movement_24h IS NOT NULL').fetchone()[0]
with_h2h = conn.execute('SELECT COUNT(*) FROM archive_matches WHERE h2h_data IS NOT NULL').fetchone()[0]
total = conn.execute('SELECT COUNT(*) FROM archive_matches').fetchone()[0]
finished = conn.execute('SELECT COUNT(*) FROM archive_matches WHERE scoreHome IS NOT NULL').fetchone()[0]
print(f'\nTotal rows: {total}')
print(f'Finished (with score): {finished}')
print(f'With teamStats: {with_ts}')
print(f'With odds_movement_24h: {with_odds}')
print(f'With h2h_data: {with_h2h}')

leagues = conn.execute("SELECT tournament_name, COUNT(*) as c FROM archive_matches WHERE scoreHome IS NOT NULL GROUP BY tournament_name ORDER BY c DESC LIMIT 15").fetchall()
print('\nTop leagues:')
for l in leagues:
    print(f'  {l["tournament_name"]}: {l["c"]}')

# Check teamStats structure if it exists
if with_ts > 0:
    ts_row = conn.execute('SELECT teamStats FROM archive_matches WHERE teamStats IS NOT NULL LIMIT 1').fetchone()
    ts = json.loads(ts_row['teamStats'])
    print(f'\nteamStats type: {type(ts).__name__}')
    if isinstance(ts, dict):
        print(f'  Keys: {list(ts.keys())[:15]}')

# Check if SofascoreScraping has a separate DB with richer data
import os
scraper_db = os.path.join('SofascoreScraping', 'data', 'database.sqlite')
if os.path.exists(scraper_db):
    sconn = sqlite3.connect(scraper_db)
    tables = sconn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    print(f'\nScraper DB tables: {[t[0] for t in tables]}')
    sconn.close()
else:
    print(f'\nNo scraper DB at {scraper_db}')

conn.close()
