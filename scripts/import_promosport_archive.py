import sqlite3
import json
import os
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'historical_archive.sqlite')
RESULTS_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'promosport_historical_results.json')
VOTES_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'tunisian_vote_history.json')
BACKUP_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'promosport_archive_pre_import.json')

conn = sqlite3.connect(DB_PATH)

# ── SAFEGUARD ─────────────────────────────────────────────────────────────────
# Avant toute reconstruction destructive, on sauvegarde les lignes existantes
# (dont les résultats frais fetchés par promosportResultService qui ne sont pas
# encore dans les JSON sources). Sinon l'auto-retrain les perdait silencieusement.
existing = conn.execute('''
    SELECT concours, match_idx, homeTeam, awayTeam, result,
           score_home, score_away, vote_home, vote_draw, vote_away, date, is_finished, archived_at
    FROM promosport_archive
''').fetchall()
with open(BACKUP_PATH, 'w', encoding='utf-8') as f:
    json.dump(existing, f, default=str)
print(f'Safeguard: {len(existing)} rows saved to {os.path.basename(BACKUP_PATH)}')

conn.executescript('''
  DROP TABLE IF EXISTS promosport_archive;
  CREATE TABLE promosport_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concours TEXT,
    match_idx INTEGER,
    homeTeam TEXT,
    awayTeam TEXT,
    result TEXT,
    score_home INTEGER,
    score_away INTEGER,
    vote_home REAL,
    vote_draw REAL,
    vote_away REAL,
    date TEXT,
    is_finished INTEGER DEFAULT 0,
    archived_at DATETIME
  );
  CREATE INDEX idx_pa_team ON promosport_archive(homeTeam, awayTeam);
  CREATE INDEX idx_pa_result ON promosport_archive(result);
  CREATE INDEX idx_pa_concours ON promosport_archive(concours);
''')

print('Table promosport_archive created')

now = datetime.now(timezone.utc).isoformat()

# 1st source: historical_results.json (no votes, no scores, just results)
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
            INSERT INTO promosport_archive (concours, match_idx, homeTeam, awayTeam, result, archived_at, is_finished)
            VALUES (?, ?, ?, ?, ?, ?, 1)
        ''', (cno, m['idx'], m['home'], m['away'], m['res'], now))
        count += 1
print(f'Imported {count} rows from historical_results.json')

# 2nd source: tunisian_vote_history.json (has votes + scores + results)
if not os.path.exists(VOTES_PATH):
    print(f'WARNING: {VOTES_PATH} not found, skipping votes')
    votes = []
else:
    with open(VOTES_PATH) as f:
        votes = json.load(f)

count2 = 0
for v in votes:
    conn.execute('''
        INSERT INTO promosport_archive (concours, match_idx, homeTeam, awayTeam, score_home, score_away, result, vote_home, vote_draw, vote_away, archived_at, is_finished)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ''', (
        str(v['grid']), v['idx'], v['home'], v['away'],
        v.get('scoreHome'), v.get('scoreAway'),
        v.get('result'), v.get('vote1'), v.get('voteX'), v.get('vote2'),
        v.get('collectedAt', now)
    ))
    count2 += 1
print(f'Imported {count2} rows from tunisian_vote_history.json')

conn.commit()

# ── RESTORE fresh data (concours non présents dans les JSON) ─────────────────
# Après le rebuild depuis les JSON, on ré-injecte les lignes sauvegardées qui
# n'existent pas encore (clé concours+match_idx) — c'est ce qui évite de perdre
# les résultats frais fetchés par checkAndFetchResults (concours récents).
existing_keys = set(
    conn.execute('SELECT concours, match_idx FROM promosport_archive').fetchall()
)
restored = 0
with open(BACKUP_PATH, encoding='utf-8') as f:
    backup_rows = json.load(f)
for r in backup_rows:
    key = (r[0], r[1])
    if key in existing_keys:
        continue
    conn.execute('''
        INSERT INTO promosport_archive
          (concours, match_idx, homeTeam, awayTeam, result, score_home, score_away,
           vote_home, vote_draw, vote_away, date, is_finished, archived_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12]))
    restored += 1
conn.commit()
print(f'Restored {restored} fresh rows not present in JSON sources')

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
