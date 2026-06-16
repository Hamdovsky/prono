import requests, re, sqlite3, time, sys
from bs4 import BeautifulSoup

HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
DB_PATH = 'data/historical_archive.sqlite'

# (league_code, league_name, page_name_template, use_year_format)
# use_year_format=True means page is like "2024_J1_League" instead of "2024-25_J1_League"
LEAGUES = [
    ('DZ1', 'Algerian Ligue 1',     '{season}_Algerian_Ligue_Professionnelle_1',  False),
    ('EG1', 'Egyptian Premier League', '{season}_Egyptian_Premier_League',         False),
    ('MA1', 'Botola',               '{season}_Botola',                             False),
    ('TN1', 'Tunisian Ligue 1',     '{season}_Tunisian_Ligue_Professionnelle_1',  False),
    ('ZA1', 'South African Premier Div', '{season}_South_African_Premier_Division', False),
    ('GH1', 'Ghana Premier League',  '{season}_Ghana_Premier_League',              False),
    ('SA1', 'Saudi Pro League',      '{season}_Saudi_Pro_League',                  False),
    ('AE1', 'UAE Pro League',        '{season}_UAE_Pro_League',                    False),
    ('QA1', 'Qatar Stars League',    '{season}_Qatar_Stars_League',                False),
    ('CN1', 'Chinese Super League',  '{year}_Chinese_Super_League',                True),
    ('JP1', 'J1 League',            '{year}_J1_League',                            True),
    ('KR1', 'K League 1',           '{year}_K_League_1',                           True),
]

def generate_season_params():
    """Generate season/year params for each league type"""
    season_params = []
    # Season-range format: 2024-25, 2023-24, etc.
    for year in range(2025, 2013, -1):
        prev = year - 1
        season_params.append(('range', f'{prev}-{year}', str(year)))
    # Year format: 2024, 2023, etc.
    for year in range(2025, 2013, -1):
        season_params.append(('year', str(year), str(year)))
    return season_params

def normalize_team(name):
    """Clean team name from Wikipedia markup"""
    name = re.sub(r'\[.*?\]', '', name)
    name = re.sub(r'\(.*?\)', '', name)
    name = re.sub(r'\s+', ' ', name).strip()
    return name

SCORE_DASH = re.compile(r'(\d+)\s*[\u2013-]+\s*(\d+)')
SCORE_RE = re.compile(r'(\d+)\s*[-]\s*(\d+)')
def unicode_fix(s):
    return s.replace('\u2013', '-').replace('\u2014', '-').replace('\u2571', '/').replace('\u2572', '\\')

def parse_crosstable(table):
    """Parse a Wikipedia crosstable (Home \ Away grid with scores)"""
    rows = table.find_all('tr')
    if len(rows) < 2:
        return []
    
    header_cells = rows[0].find_all(['th', 'td'])
    if len(header_cells) < 2:
        return []
    
    # Get column team abbreviations
    col_abbrevs = []
    for c in header_cells[1:]:
        abbrev = normalize_team(c.get_text().strip())
        if abbrev:
            col_abbrevs.append(abbrev)
    
    if len(col_abbrevs) < 2:
        return []
    
    # Build abbreviation → full name mapping from row headers
    abbrev_map = {}
    for row in rows[1:]:
        cells = row.find_all(['th', 'td'])
        if not cells:
            continue
        raw_name = cells[0].get_text().strip()
        # Clean the name and try to find its abbreviation
        clean_name = normalize_team(raw_name)
        if not clean_name:
            continue
        # The full name in the row might match one of the col abbrevs
        # Try direct match first
        for ab in col_abbrevs:
            if ab.lower() == clean_name.lower():
                abbrev_map[ab] = clean_name
                break
        else:
            # Try to find abbreviation in the name
            for ab in col_abbrevs:
                if ab.lower() in clean_name.lower():
                    abbrev_map[ab] = clean_name
                    break
            else:
                # Try the cell text itself (might be a link or span with full name)
                # Use the first abbreviation that isn't already mapped
                for c in cells[0].find_all(['a', 'span']):
                    full = normalize_team(c.get_text().strip())
                    if full and len(full) > 3:
                        for ab in col_abbrevs:
                            if ab not in abbrev_map:
                                abbrev_map[ab] = full
                            break
                        break
    
    matches = []
    for row_idx, row in enumerate(rows[1:]):
        cells = row.find_all(['th', 'td'])
        if len(cells) < 2:
            continue
        
        raw_home = cells[0].get_text().strip()
        home_name = normalize_team(raw_home)
        if not home_name:
            continue
        
        for col_idx, cell in enumerate(cells[1:]):
            if col_idx >= len(col_abbrevs):
                break
            
            score_text = unicode_fix(cell.get_text().strip())
            m = SCORE_RE.match(score_text)
            if not m:
                continue
            
            sh, sa = int(m.group(1)), int(m.group(2))
            away_abbrev = col_abbrevs[col_idx]
            away_name = abbrev_map.get(away_abbrev, away_abbrev)
            result = 'H' if sh > sa else ('A' if sa > sh else 'D')
            
            matches.append((home_name, away_name, sh, sa, result))
    
    return matches

def parse_match_table(table):
    """Parse individual match listing tables (Date, Home, Score, Away columns)"""
    rows = table.find_all('tr')
    if len(rows) < 2:
        return []
    
    header_cells = rows[0].find_all(['th', 'td'])
    headers = [c.get_text().strip().lower() for c in header_cells]
    
    date_idx = next((i for i, h in enumerate(headers) if 'date' in h), -1)
    home_idx = next((i for i, h in enumerate(headers) if h in ['home', 'home team', 'team 1', 'h']), -1)
    away_idx = next((i for i, h in enumerate(headers) if h in ['away', 'away team', 'team 2', 'a']), -1)
    score_idx = next((i for i, h in enumerate(headers) if h in ['score', 'result', 'res.', 'ft']), -1)
    
    if home_idx < 0 or away_idx < 0:
        return []
    
    matches = []
    for row in rows[1:]:
        cells = row.find_all(['th', 'td'])
        row_text = row.get_text()
        
        scores = re.findall(r'(\d+)[-–](\d+)', row_text)
        if not scores:
            continue
        
        sh, sa = int(scores[0][0]), int(scores[0][1])
        
        home = normalize_team(cells[home_idx].get_text().strip()) if home_idx < len(cells) else ''
        away = normalize_team(cells[away_idx].get_text().strip()) if away_idx < len(cells) else ''
        date = cells[date_idx].get_text().strip() if date_idx >= 0 and date_idx < len(cells) else ''
        
        if home and away:
            result = 'H' if sh > sa else ('A' if sa > sh else 'D')
            matches.append((home, away, sh, sa, result, date))
    
    return matches

def scrape_wikipedia(season_code, page_name):
    """Fetch a Wikipedia page and extract match data"""
    url = 'https://en.wikipedia.org/wiki/' + page_name
    
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        if r.status_code != 200:
            return None
    except Exception as e:
        return None
    
    soup = BeautifulSoup(r.text, 'html.parser')
    tables = soup.find_all('table', class_='wikitable')
    
    all_matches = []
    all_home_away_matches = []
    
    for table in tables:
        rows = table.find_all('tr')
        if len(rows) < 2:
            continue
        
        header_cells = rows[0].find_all(['th', 'td'])
        if not header_cells:
            continue
        
        header_text = ' '.join([c.get_text().strip().lower() for c in header_cells[:4]])
        
        # Check for scores in first few data rows
        score_count = sum(1 for rw in rows[1:4] for c in rw.find_all(['td']) if re.search(r'\d+[–-]\d+', c.get_text()))
        
        if score_count < 3:
            continue
        
        # Check if crosstable (many score columns per row)
        if 'home' in header_text or '\\' in header_text:
            crosstable_matches = parse_crosstable(table)
            if crosstable_matches:
                all_matches.extend(crosstable_matches)
        else:
            # Try as match listing table
            match_matches = parse_match_table(table)
            if match_matches:
                all_home_away_matches.extend(match_matches)
    
    return all_matches or all_home_away_matches or None

def insert_matches(conn, league_code, season_code, matches):
    """Insert matches into archive_football_data, avoiding duplicates"""
    if not matches:
        return 0
    
    cur = conn.cursor()
    count = 0
    skipped = 0
    
    for match in matches:
        if len(match) == 5:
            home, away, sh, sa, result = match
            date = ''
        else:
            home, away, sh, sa, result, date = match
        
        if not home or not away:
            skipped += 1
            continue
        
        if result not in ('H', 'A', 'D'):
            result = 'H' if sh > sa else ('A' if sa > sh else 'D')
        
        cur.execute("""
            INSERT OR IGNORE INTO archive_football_data
                (league_code, season_code, match_date, home_team, away_team, score_home, score_away, result_full)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (league_code, season_code, date, home, away, sh, sa, result))
        
        if cur.rowcount > 0:
            count += 1
            skipped += 1
    
    conn.commit()
    return count

def gen_seasons(use_year):
    if use_year:
        for y in range(2025, 2013, -1):
            yield str(y)
    else:
        for y in range(2025, 2013, -1):
            prev = y - 1
            yield f'{prev}-{y}'

def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    
    total_inserted = 0
    
    print('=' * 70)
    print('Wikipedia Historical Match Scraper for African/Asian Leagues')
    print('=' * 70)
    
    for league_code, league_name, template, use_year in LEAGUES:
        print()
        print('--- ' + league_code + ': ' + league_name + ' ---')
        
        for season in gen_seasons(use_year):
            if use_year:
                page_name = template.replace('{year}', season)
            else:
                page_name = template.replace('{season}', season)
            
            # Check if data already exists
            cur.execute("SELECT COUNT(*) FROM archive_football_data WHERE league_code = ? AND season_code = ?",
                        (league_code, season))
            existing = cur.fetchone()[0]
            if existing > 10:
                print('  ' + season + ': ' + str(existing) + ' matches (skip)')
                continue
            
            sys.stdout.write('  ' + season + ': ')
            sys.stdout.flush()
            
            matches = scrape_wikipedia(season, page_name)
            
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
    print('Total new matches inserted: ' + str(total_inserted))
    print('Done!')

if __name__ == '__main__':
    main()
