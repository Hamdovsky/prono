import sqlite3
import json
import os
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'historical_archive.sqlite')
RESULTS_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'promosport_historical_results.json')
VOTES_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'tunisian_vote_history.json')

conn = sqlite3.connect(DB_PATH)

conn.executescript('''
  DROP TABLE IF EXISTS promosport_archive;
  CREATE TABLE promosport_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concours TEXT,
    idx INTEGER,
    homeTeam TEXT,
    awayTeam TEXT,
    result TEXT,
    score_home INTEGER,
    score_away INTEGER,
    vote_home REAL,
    vote_draw REAL,
    vote_away REAL,
    archived_at DATETIME
  );
  CREATE INDEX idx_pa_team ON promosport_archive(homeTeam, awayTeam);
  CREATE INDEX idx_pa_result ON promosport_archive(result);
  CREATE INDEX idx_pa_concours ON promosport_archive(concours);
''')

print('Table promosport_archive created')

# 1st source: historical_results.json (no votes, just results)
if not os.path.exists(RESULTS_PATH):
    print(f'WARNING: {RESULTS_PATH} not found, skipping historical results')
    results = []
else:
    with open(RESULTS_PATH) as f:
        results = json.load(f)

count = 0
for concours in results:
    cno = concours['no']
    for m in concours['matches']:
        conn.execute('''
            INSERT INTO promosport_archive (concours, idx, homeTeam, awayTeam, result, archived_at)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (cno, m['idx'], m['home'], m['away'], m['res'], datetime.utcnow().isoformat()))
        count += 1
print(f'Imported {count} rows from historical_results.json')

# 2nd source: tunisian_vote_history.json (has votes + results)
if not os.path.exists(VOTES_PATH):
    print(f'WARNING: {VOTES_PATH} not found, skipping votes')
    votes = []
else:
    with open(VOTES_PATH) as f:
        votes = json.load(f)

count2 = 0
for v in votes:
    conn.execute('''
        INSERT INTO promosport_archive (concours, idx, homeTeam, awayTeam, score_home, score_away, result, vote_home, vote_draw, vote_away, archived_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        str(v['grid']), v['idx'], v['home'], v['away'],
        v.get('scoreHome'), v.get('scoreAway'),
        v.get('result'), v.get('vote1'), v.get('voteX'), v.get('vote2'),
        v.get('collectedAt', datetime.utcnow().isoformat())
    ))
    count2 += 1
print(f'Imported {count2} rows from tunisian_vote_history.json')

conn.commit()

# Verify
total = conn.execute('SELECT COUNT(*) FROM promosport_archive').fetchone()[0]
with_votes = conn.execute('SELECT COUNT(*) FROM promosport_archive WHERE vote_home IS NOT NULL').fetchone()[0]
with_results = conn.execute('SELECT COUNT(*) FROM promosport_archive WHERE result IS NOT NULL AND result != "N"').fetchone()[0]
teams = conn.execute('SELECT COUNT(DISTINCT homeTeam) FROM promosport_archive').fetchone()[0]
print(f'\nTotal rows: {total}')
print(f'With votes: {with_votes}')
print(f'With results: {with_results}')
print(f'Unique teams: {teams}')

conn.close()
print('\nDone!')
