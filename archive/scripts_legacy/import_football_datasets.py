"""
Import football-data.co.uk historical datasets into historical_archive.sqlite.
Covers 5 major European leagues: EPL, La Liga, Bundesliga, Serie A, Ligue 1.
Also imports all_leagues.csv (worldfootballR Fotmob league catalogue).
"""
import csv
import io
import json
import os
import sqlite3
import sys
import time
from datetime import datetime
from urllib.request import urlopen, Request

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARCHIVE_PATH = os.path.join(BASE_DIR, 'data', 'historical_archive.sqlite')

LEAGUES = {
    'E0':  'English Premier League',
    'SP1': 'Spanish La Liga',
    'D1':  'German Bundesliga',
    'I1':  'Italian Serie A',
    'F1':  'French Ligue 1',
}

START_YEAR = 1993
END_YEAR = 2025  # 2025-26 season

FD_BASE = 'https://www.football-data.co.uk/mmz4281/{season}/{league}.csv'
ALL_LEAGUES_URL = 'https://raw.githubusercontent.com/JaseZiv/worldfootballR_data/master/raw-data/fotmob-leagues/all_leagues.csv'

# Target column order for archive
ARCHIVE_COLS = [
    'league_code', 'season_code', 'match_date', 'home_team', 'away_team',
    'score_home', 'score_away', 'result_full', 'score_home_ht', 'score_away_ht', 'result_ht',
    'referee',
    'shots_home', 'shots_away', 'sot_home', 'sot_away',
    'fouls_home', 'fouls_away', 'corners_home', 'corners_away',
    'yellow_home', 'yellow_away', 'red_home', 'red_away',
    'odds_home', 'odds_draw', 'odds_away',
    'over_under_line', 'odds_over', 'odds_under',
    'asian_handicap_line', 'odds_asian_home', 'odds_asian_away',
    'closing_odds_home', 'closing_odds_draw', 'closing_odds_away',
    'raw_json',
]

TABLE_NAME = 'archive_football_data'


def ensure_schema(conn):
    c = conn.cursor()
    c.execute(f'''
        CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            league_code TEXT,
            season_code TEXT,
            match_date TEXT,
            home_team TEXT,
            away_team TEXT,
            score_home INTEGER,
            score_away INTEGER,
            result_full TEXT,
            score_home_ht INTEGER,
            score_away_ht INTEGER,
            result_ht TEXT,
            referee TEXT,
            shots_home INTEGER,
            shots_away INTEGER,
            sot_home INTEGER,
            sot_away INTEGER,
            fouls_home INTEGER,
            fouls_away INTEGER,
            corners_home INTEGER,
            corners_away INTEGER,
            yellow_home INTEGER,
            yellow_away INTEGER,
            red_home INTEGER,
            red_away INTEGER,
            odds_home REAL,
            odds_draw REAL,
            odds_away REAL,
            over_under_line REAL,
            odds_over REAL,
            odds_under REAL,
            asian_handicap_line REAL,
            odds_asian_home REAL,
            odds_asian_away REAL,
            closing_odds_home REAL,
            closing_odds_draw REAL,
            closing_odds_away REAL,
            raw_json TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    c.execute(f'''
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_unique 
        ON {TABLE_NAME}(league_code, season_code, match_date, home_team, away_team)
    ''')
    conn.commit()


def safe_int(val):
    if val is None:
        return None
    val = val.strip()
    if val == '':
        return None
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


def safe_float(val):
    if val is None:
        return None
    val = val.strip()
    if val == '':
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def parse_date(date_str):
    """football-data uses DD/MM/YY or DD/MM/YYYY"""
    if not date_str:
        return None
    date_str = date_str.strip()
    for fmt in ('%d/%m/%y', '%d/%m/%Y'):
        try:
            return datetime.strptime(date_str, fmt).strftime('%Y-%m-%d')
        except ValueError:
            continue
    return date_str


def fetch_csv(url):
    req = Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        resp = urlopen(req, timeout=30)
        raw = resp.read().decode('latin-1')
        return list(csv.DictReader(io.StringIO(raw)))
    except Exception as e:
        return None


def download_season(league_code, season_code):
    url = FD_BASE.format(season=season_code, league=league_code)
    print(f'  {league_code} {season_code}...', flush=True)
    rows = fetch_csv(url)
    if rows is None or len(rows) == 0:
        print(f'    SKIP (no data)')
        return []
    if len(rows) > 0:
        first = rows[0]
        has_data = any(v and v.strip() for k, v in first.items() if k not in ('Div', 'Date', 'HomeTeam', 'AwayTeam'))
        if not has_data:
            print(f'    SKIP (empty stats)')
            return []
        has_match = first.get('FTHG') or first.get('HomeTeam')
        if not has_match or not first.get('HomeTeam', '').strip():
            print(f'    SKIP (header only)')
            return []
    print(f'    -> {len(rows)} matches')
    return rows


def row_to_archive(row, league_code, season_code):
    """Convert a football-data.co.uk CSV row to archive columns."""
    r = row
    home_score = safe_int(r.get('FTHG'))
    away_score = safe_int(r.get('FTAG'))

    if home_score is None or away_score is None:
        return None

    # Best available odds (Bet365 > Pinnacle > Bet365 closing)
    odds_h = safe_float(r.get('B365H')) or safe_float(r.get('PSH')) or safe_float(r.get('B365CH'))
    odds_d = safe_float(r.get('B365D')) or safe_float(r.get('PSD')) or safe_float(r.get('B365CD'))
    odds_a = safe_float(r.get('B365A')) or safe_float(r.get('PSA')) or safe_float(r.get('B365CA'))

    # Over/Under
    ou_line = safe_float(r.get('AHh'))  # Asian Handicap line - also used for O/U
    odds_o = safe_float(r.get('B365>2.5')) or safe_float(r.get('P>2.5'))
    odds_u = safe_float(r.get('B365<2.5')) or safe_float(r.get('P<2.5'))

    # Closing odds
    close_h = safe_float(r.get('B365CH')) or safe_float(r.get('PSCH'))
    close_d = safe_float(r.get('B365CD')) or safe_float(r.get('PSCD'))
    close_a = safe_float(r.get('B365CA')) or safe_float(r.get('PSCA'))

    # Asian Handicap
    ah_line = safe_float(r.get('AHh') or r.get('AHCh'))
    ah_h = safe_float(r.get('B365AHH') or r.get('B365CAHH'))
    ah_a = safe_float(r.get('B365AHA') or r.get('B365CAHA'))

    return {
        'league_code': league_code,
        'season_code': season_code,
        'match_date': parse_date(r.get('Date')),
        'home_team': r.get('HomeTeam', '').strip(),
        'away_team': r.get('AwayTeam', '').strip(),
        'score_home': home_score,
        'score_away': away_score,
        'result_full': r.get('FTR', '').strip() or None,
        'score_home_ht': safe_int(r.get('HTHG')),
        'score_away_ht': safe_int(r.get('HTAG')),
        'result_ht': r.get('HTR', '').strip() or None,
        'referee': r.get('Referee', '').strip() or None,
        'shots_home': safe_int(r.get('HS')),
        'shots_away': safe_int(r.get('AS')),
        'sot_home': safe_int(r.get('HST')),
        'sot_away': safe_int(r.get('AST')),
        'fouls_home': safe_int(r.get('HF')),
        'fouls_away': safe_int(r.get('AF')),
        'corners_home': safe_int(r.get('HC')),
        'corners_away': safe_int(r.get('AC')),
        'yellow_home': safe_int(r.get('HY')),
        'yellow_away': safe_int(r.get('AY')),
        'red_home': safe_int(r.get('HR')),
        'red_away': safe_int(r.get('AR')),
        'odds_home': odds_h,
        'odds_draw': odds_d,
        'odds_away': odds_a,
        'over_under_line': ou_line,
        'odds_over': odds_o,
        'odds_under': odds_u,
        'asian_handicap_line': ah_line,
        'odds_asian_home': ah_h,
        'odds_asian_away': ah_a,
        'closing_odds_home': close_h,
        'closing_odds_draw': close_d,
        'closing_odds_away': close_a,
        'raw_json': json.dumps(r) if r else None,
    }


def import_season(conn, league_code, season_code):
    rows = download_season(league_code, season_code)
    if not rows:
        return 0

    cur = conn.cursor()
    inserted = 0
    skipped = 0

    for row in rows:
        try:
            rec = row_to_archive(row, league_code, season_code)
            if rec is None:
                skipped += 1
                continue

            cols = ', '.join(rec.keys())
            placeholders = ', '.join(['?' for _ in rec])
            update_cols = ', '.join([f'{k}=excluded.{k}' for k in rec.keys()])

            cur.execute(f'''
                INSERT INTO {TABLE_NAME} ({cols}) VALUES ({placeholders})
                ON CONFLICT(league_code, season_code, match_date, home_team, away_team) 
                DO UPDATE SET {update_cols}
            ''', list(rec.values()))
            inserted += 1
        except Exception as e:
            skipped += 1

    conn.commit()
    return inserted


def import_fotmob_leagues(conn):
    """Import all_leagues.csv from worldfootballR_data as a reference table."""
    print('\n[FOTMOB] Downloading all_leagues.csv...')
    req = Request(ALL_LEAGUES_URL, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        resp = urlopen(req, timeout=30)
        raw = resp.read().decode('utf-8', errors='replace')
        reader = csv.DictReader(io.StringIO(raw))
        rows = list(reader)
    except Exception as e:
        print(f'  FAILED: {e}')
        return 0

    cur = conn.cursor()
    cur.execute('''
        CREATE TABLE IF NOT EXISTS fotmob_leagues (
            id INTEGER PRIMARY KEY,
            ccode TEXT,
            country TEXT,
            name TEXT,
            page_url TEXT
        )
    ''')
    cur.execute('DELETE FROM fotmob_leagues')
    inserted = 0
    for r in rows:
        try:
            league_id = int(r.get('id', 0))
            cur.execute(
                'INSERT OR REPLACE INTO fotmob_leagues (id, ccode, country, name, page_url) VALUES (?,?,?,?,?)',
                (league_id, r.get('ccode', ''), r.get('country', ''), r.get('name', ''), r.get('page_url', ''))
            )
            inserted += 1
        except (ValueError, TypeError):
            continue
    conn.commit()
    print(f'  Inserted {inserted} Fotmob leagues')
    return inserted


def main():
    print('=' * 60)
    print('  Import Football Data Archives')
    print('=' * 60)

    conn = sqlite3.connect(ARCHIVE_PATH)
    ensure_schema(conn)

    total_inserted = 0
    season_errors = []

    for league_code, league_name in LEAGUES.items():
        print(f'\n--- {league_name} ({league_code}) ---')
        for yr in range(START_YEAR, END_YEAR + 1):
            year1 = yr % 100
            year2 = (yr + 1) % 100
            season_code = f'{year1:02d}{year2:02d}'
            try:
                cnt = import_season(conn, league_code, season_code)
                total_inserted += cnt
            except Exception as e:
                season_errors.append(f'{league_code}/{season_code}: {e}')
                print(f'  ERROR: {e}')
            time.sleep(0.3)

    # Import Fotmob leagues
    import_fotmob_leagues(conn)

    # Summary
    cur = conn.cursor()
    total = cur.execute(f'SELECT COUNT(*) FROM {TABLE_NAME}').fetchone()[0]
    with_scores = cur.execute(f'SELECT COUNT(*) FROM {TABLE_NAME} WHERE score_home IS NOT NULL').fetchone()[0]
    with_odds = cur.execute(f'SELECT COUNT(*) FROM {TABLE_NAME} WHERE odds_home IS NOT NULL').fetchone()[0]

    conn.close()

    print(f'\n{"=" * 60}')
    print(f'  IMPORT COMPLETE')
    print(f'  Total rows in {TABLE_NAME}: {total}')
    print(f'  With scores: {with_scores}')
    print(f'  With odds (Bet365): {with_odds}')
    print(f'  Newly inserted: {total_inserted}')
    if season_errors:
        print(f'  Errors ({len(season_errors)}):')
        for e in season_errors[:5]:
            print(f'    - {e}')
    print(f'{"=" * 60}')


if __name__ == '__main__':
    main()
