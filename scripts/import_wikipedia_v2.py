import requests, re, sqlite3, time, sys
from bs4 import BeautifulSoup

HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
DB_PATH = 'data/historical_archive.sqlite'

LEAGUES = [
    ('MA1', 'Botola',              '{season}_Botola',                             False),
    ('EG1', 'Egyptian PL',         '{season}_Egyptian_Premier_League',            False),
    ('SA1', 'Saudi Pro League',    '{season}_Saudi_Pro_League',                   False),
    ('ZA1', 'South African Prem',  '{season}_South_African_Premier_Division',     False),
    ('DZ1', 'Algerian Ligue 1',    '{season}_Algerian_Ligue_Professionnelle_1',   False),
    ('TN1', 'Tunisian Ligue 1',    '{season}_Tunisian_Ligue_Professionnelle_1',   False),
    ('GH1', 'Ghana Premier League','{season}_Ghana_Premier_League',               False),
    ('CN1', 'Chinese Super League','{year}_Chinese_Super_League',                  True),
    ('JP1', 'J1 League',           '{year}_J1_League',                             True),
    ('KR1', 'K League 1',          '{year}_K_League_1',                            True),
]

def norm_team(n):
    n = re.sub(r'\[.*?\]', '', n)
    n = re.sub(r'\(.*?\)', '', n)
    n = re.sub(r'\s+', ' ', n).strip()
    return n

def fix_enc(s):
    """Replace Unicode dashes and box-drawing chars with ASCII"""
    return s.replace('\u2013', '-').replace('\u2014', '-').replace('\u2571', '/').replace('\u2572', '\\')

def extract_scores(text):
    """Find all score patterns in text, return list of (home_score, away_score)"""
    fixed = fix_enc(text)
    return re.findall(r'(\d+)\s*-\s*(\d+)', fixed)

def parse_crosstable(table):
    rows = table.find_all('tr')
    if len(rows) < 2:
        return []

    header_cells = rows[0].find_all(['th', 'td'])
    if len(header_cells) < 2:
        return []

    col_abbrevs = []
    for c in header_cells[1:]:
        ab = norm_team(c.get_text().strip())
        if ab:
            col_abbrevs.append(ab)
    if len(col_abbrevs) < 2:
        return []

    # Build abbrev -> full name mapping
    # Row headers have full names, column headers have abbreviations
    # Try to match: find full name from row header link text
    abbrev_map = {}
    for row in rows[1:]:
        cells = row.find_all(['th', 'td'])
        if not cells:
            continue
        # Get the full team name from the first cell (link text or cell text)
        first_cell = cells[0]
        full_name = ''
        # Try to get text from link first
        link = first_cell.find('a')
        if link:
            full_name = norm_team(link.get_text().strip())
        if not full_name:
            full_name = norm_team(first_cell.get_text().strip())
        if not full_name:
            continue

        # Match this full name to its abbreviation
        # Strategy: find the abbreviation that is a substring of the full name
        best_ab = None
        best_score = 0
        for ab in col_abbrevs:
            if ab in abbrev_map:
                continue
            # Check if abbreviation letters appear in order in the full name
            ab_lower = ab.lower()
            fn_lower = full_name.lower()
            if ab_lower in fn_lower:
                # Prefer closer matches (abbreviation length vs name length)
                score = len(ab) / len(fn_lower)
                if score > best_score:
                    best_score = score
                    best_ab = ab

        if best_ab:
            abbrev_map[best_ab] = full_name

    # If mapping failed, try another approach: match by row index
    # The first row header should match the first column abbreviation, etc.
    if len(abbrev_map) < len(col_abbrevs) / 2:
        for i, row in enumerate(rows[1:]):
            if i >= len(col_abbrevs):
                break
            cells = row.find_all(['th', 'td'])
            if not cells:
                continue
            ab = col_abbrevs[i]
            if ab in abbrev_map:
                continue
            link = cells[0].find('a')
            if link:
                full_name = norm_team(link.get_text().strip())
                if full_name:
                    abbrev_map[ab] = full_name
            if ab not in abbrev_map:
                full_name = norm_team(cells[0].get_text().strip())
                if full_name:
                    abbrev_map[ab] = full_name

    matches = []
    for row_idx, row in enumerate(rows[1:]):
        cells = row.find_all(['th', 'td'])
        if len(cells) < 2:
            continue

        # Home team from row header
        link = cells[0].find('a')
        home_name = norm_team(link.get_text().strip()) if link else norm_team(cells[0].get_text().strip())
        if not home_name:
            home_name = norm_team(cells[0].get_text().strip())
        if not home_name:
            continue

        for col_idx, cell in enumerate(cells[1:]):
            if col_idx >= len(col_abbrevs):
                break

            scores = extract_scores(cell.get_text().strip())
            if not scores:
                continue

            sh, sa = int(scores[0][0]), int(scores[0][1])
            away_ab = col_abbrevs[col_idx]
            away_name = abbrev_map.get(away_ab, away_ab)
            result = 'H' if sh > sa else ('A' if sa > sh else 'D')

            matches.append((home_name, away_name, sh, sa, result))

    return matches

def parse_league_table(table):
    """Try to extract match data from a league table (Pos | Team | Pld | W | D | L | GF | GA)"""
    rows = table.find_all('tr')
    if len(rows) < 2:
        return []

    header_cells = rows[0].find_all(['th', 'td'])
    headers = [c.get_text().strip().lower() for c in header_cells]

    # Check if this is a league table (has Pos, Team, Pld, W, D, L columns)
    has_pos = any('pos' in h for h in headers)
    has_pld = any(h in ('pld', 'played', 'mp') for h in headers)
    has_w = any(h in ('w', 'won') for h in headers)
    has_gf = any(h in ('gf', 'gd', 'ga', 'goals') for h in headers)

    if not (has_pos and has_pld):
        return []

    # This is a league table, not match data
    return []

def scrape_page(season_code, page_name):
    url = 'https://en.wikipedia.org/wiki/' + page_name
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        if r.status_code != 200:
            return None
    except:
        return None

    soup = BeautifulSoup(r.text, 'html.parser')
    all_tables = soup.find_all('table', class_='wikitable')

    all_matches = []

    for table in all_tables:
        rows = table.find_all('tr')
        if len(rows) < 2:
            continue

        header_cells = rows[0].find_all(['th', 'td'])
        if len(header_cells) < 2:
            continue

        header_text = ' '.join([c.get_text().strip().lower() for c in header_cells[:4]])

        # Check if this looks like a crosstable (Home \ Away pattern)
        # by checking the header and looking for many scores in data rows
        score_count = 0
        for rw in rows[1:5]:
            score_count += len(extract_scores(rw.get_text()))

        if score_count < 5:
            continue

        # Try crosstable parse if header has home/away markers or has many scores
        if 'home' in header_text or '\\' in header_text or score_count > 20:
            crosstable_matches = parse_crosstable(table)
            if crosstable_matches:
                all_matches.extend(crosstable_matches)

    return all_matches if all_matches else None

def insert_matches(conn, league_code, season_code, matches):
    if not matches:
        return 0

    cur = conn.cursor()
    count = 0
    for match in matches:
        home, away, sh, sa, result = match
        if not home or not away:
            continue
        cur.execute("""
            INSERT OR IGNORE INTO archive_football_data
                (league_code, season_code, home_team, away_team, score_home, score_away, result_full)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (league_code, season_code, home, away, sh, sa, result))
        if cur.rowcount > 0:
            count += 1
    conn.commit()
    return count

def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    total_inserted = 0

    print('=' * 60)
    print('Wikipedia Historical Match Scraper')
    print('=' * 60)

    for league_code, league_name, template, use_year in LEAGUES:
        print()
        print('--- ' + league_code + ': ' + league_name + ' ---')

        for season in gen_seasons(use_year):
            if use_year:
                page_name = template.replace('{year}', season)
            else:
                page_name = template.replace('{season}', season)

            # Skip if data already exists
            cur.execute("SELECT COUNT(*) FROM archive_football_data WHERE league_code = ? AND season_code = ?",
                        (league_code, season))
            existing = cur.fetchone()[0]
            if existing > 10:
                print('  ' + season + ': ' + str(existing) + ' matches (skip)')
                continue

            sys.stdout.write('  ' + season + ': ')
            sys.stdout.flush()

            matches = scrape_page(season, page_name)

            if matches:
                inserted = insert_matches(conn, league_code, season, matches)
                total_inserted += inserted
                print(str(inserted) + ' new matches')
            else:
                print('no data')
            time.sleep(0.5)

        conn.commit()

    conn.close()
    print()
    print('Total new matches: ' + str(total_inserted))
    print('Done!')

def gen_seasons(use_year):
    if use_year:
        for y in range(2025, 2013, -1):
            yield str(y)
    else:
        for y in range(2025, 2013, -1):
            prev = y - 1
            yield str(prev) + '-' + str(y)[-2:]

if __name__ == '__main__':
    main()
