"""
Import all remaining leagues from Wikipedia.
Extends import_wikipedia_v2.py with full list of leagues.
"""
import requests, re, sqlite3, time, sys, urllib.parse, json
from bs4 import BeautifulSoup

HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
DB_PATH = 'data/historical_archive.sqlite'

# (code, name, template, is_single_year, url_suffix)
# url_suffix is for pages with parenthesized disambiguation, e.g. "_(Peru)"
LEAGUES = [
    # ===== South America =====
    ('BRA', 'Brazil Serie A',          '{year}_Campeonato_Brasileiro_Serie_A', True, ''),
    ('ARG', 'Argentina Primera',       '{year}_AFA_Liga_Profesional_de_Futbol', True, ''),
    ('COL', 'Colombia Primera A',      '{year}_Liga_DIMAYOR', True, ''),
    ('PER', 'Peru Liga 1',             '{year}_Liga_1', True, '_(Peru)'),
    ('ECU', 'Ecuador Serie A',         '{year}_Ecuadorian_Serie_A', True, ''),
    ('PAR', 'Paraguay Primera',        '{year}_Copa_de_Primera', True, ''),
    ('VEN', 'Venezuela Primera',       '{year}_Liga_FUTVE', True, ''),

    # ===== Africa =====
    ('NGA', 'Nigeria NPFL',            '{season}_Nigeria_Premier_Football_League', False, ''),
    ('CIV', 'Cote Ivoire Ligue 1',     '{season}_Ligue_1', False, '_(Ivory_Coast)'),
    ('CMR', 'Cameroon Elite One',      '{season}_Elite_One', False, ''),
    ('COD', 'DR Congo Linafoot',       '{season}_Linafoot', False, ''),
    ('KEN', 'Kenya Premier League',    '{season}_Kenyan_Premier_League', False, ''),
    ('TZA', 'Tanzania Premier',        '{season}_Tanzanian_Premier_League', False, ''),
    ('UGA', 'Uganda Premier',          '{season}_Uganda_Premier_League', False, ''),
    ('ETH', 'Ethiopian Premier',       '{season}_Ethiopian_Premier_League', False, ''),
    ('LBY', 'Libyan Premier',          '{season}_Libyan_Premier_League', False, ''),
    ('ZMB', 'Zambia Super League',     '{season}_Zambia_Super_League', False, ''),

    # ===== Asia =====
    ('UAE', 'UAE Pro League',          '{season}_UAE_Pro_League', False, ''),
    ('QAT', 'Qatar Stars League',      '{season}_Qatar_Stars_League', False, ''),
    ('IND', 'Indian Super League',     '{season}_Indian_Super_League', False, ''),
    ('IRQ', 'Iraq Stars League',       '{season}_Iraq_Stars_League', False, ''),
    ('IRN', 'Iran Pro League',         '{season}_Persian_Gulf_Pro_League', False, ''),
    ('KUW', 'Kuwait Premier',          '{season}_Kuwaiti_Premier_League', False, ''),
    ('OMA', 'Oman League',             '{season}_Oman_Professional_League', False, ''),
    ('BHR', 'Bahrain Premier',         '{season}_Bahraini_Premier_League', False, ''),
    ('JOR', 'Jordan Pro League',       '{season}_Jordanian_Pro_League', False, ''),
    ('THA', 'Thai League 1',           '{season}_Thai_League_1', False, ''),
    ('VNM', 'Vietnam V-League',        '{season}_V.League_1', False, ''),
    ('IDN', 'Indonesia Liga 1',        '{season}_Liga_1', False, '_(Indonesia)'),
    ('MYS', 'Malaysia Super League',   '{season}_Malaysia_Super_League', False, ''),
    ('SGP', 'Singapore Premier',       '{season}_Singapore_Premier_League', False, ''),
    ('AUS', 'A-League Men',            '{season}_A-League_Men', False, ''),
    ('UZB', 'Uzbekistan League',       '{year}_Uzbekistan_Super_League', True, ''),
    ('KAZ', 'Kazakhstan Premier',      '{year}_Kazakhstan_Premier_League', True, ''),

    # ===== North America =====
    ('MEX', 'Mexico Liga MX',          '{season}_Liga_MX', False, ''),
    ('USA', 'USA Major League',        '{year}_Major_League_Soccer_season', True, ''),
    ('HON', 'Honduras Liga',           '{season}_Honduran_Liga_Nacional', False, ''),
    ('GUA', 'Guatemala Liga',          '{season}_Liga_Nacional_de_Guatemala', False, ''),
    ('JAM', 'Jamaica Premier',         '{season}_Jamaica_Premier_League', False, ''),
    ('CAN', 'Canada Premier',          '{year}_Canadian_Premier_League_season', True, ''),
    ('CRC', 'Costa Rica FPD',          '{season}_Liga_FPD', False, ''),

    # ===== Oceania =====
    ('NZL', 'New Zealand National',    '{year}_New_Zealand_National_League', True, ''),
]

def gen_seasons(use_year):
    if use_year:
        for y in range(2025, 2013, -1):
            yield str(y)
    else:
        for y in range(2025, 2013, -1):
            prev = y - 1
            yield str(prev) + '-' + str(y)[-2:]

def norm_team(n):
    n = re.sub(r'\[.*?\]', '', n)
    n = re.sub(r'\(.*?\)', '', n)
    n = re.sub(r'\s+', ' ', n).strip()
    return n

def fix_enc(s):
    return s.replace('\u2013', '-').replace('\u2014', '-').replace('\u2571', '/').replace('\u2572', '\\')

def extract_scores(text):
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

    abbrev_map = {}
    for row in rows[1:]:
        cells = row.find_all(['th', 'td'])
        if not cells:
            continue
        first_cell = cells[0]
        full_name = ''
        link = first_cell.find('a')
        if link:
            full_name = norm_team(link.get_text().strip())
        if not full_name:
            full_name = norm_team(first_cell.get_text().strip())
        if not full_name:
            continue

        best_ab = None
        best_score = 0
        for ab in col_abbrevs:
            if ab in abbrev_map:
                continue
            ab_lower = ab.lower()
            fn_lower = full_name.lower()
            if ab_lower in fn_lower:
                score = len(ab) / len(fn_lower)
                if score > best_score:
                    best_score = score
                    best_ab = ab

        if best_ab:
            abbrev_map[best_ab] = full_name

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

def scrape_page(page_name):
    url = 'https://en.wikipedia.org/wiki/' + urllib.parse.quote(page_name, safe='/:_.()-')
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

        score_count = 0
        for rw in rows[1:5]:
            score_count += len(extract_scores(rw.get_text()))

        if score_count < 5:
            continue

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

def build_page_name(template, season, use_year, suffix):
    if use_year:
        base = template.replace('{year}', season)
    else:
        base = template.replace('{season}', season)
    return base + suffix

def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    total_inserted = 0
    total_leagues = 0
    total_skipped = 0
    failures = []

    print('=' * 70)
    print('Wikipedia Global League Historical Match Scraper')
    print('=' * 70)

    for league_code, league_name, template, use_year, suffix in LEAGUES:
        total_leagues += 1
        print()
        print('--- ' + league_code + ': ' + league_name + ' ---')

        league_inserted = 0
        for season in gen_seasons(use_year):
            page_name = build_page_name(template, season, use_year, suffix)

            # Skip if data already exists
            cur.execute("SELECT COUNT(*) FROM archive_football_data WHERE league_code = ? AND season_code = ?",
                        (league_code, season))
            existing = cur.fetchone()[0]
            if existing > 10:
                print('  ' + season + ': ' + str(existing) + ' matches (skip)')
                total_skipped += 1
                continue

            sys.stdout.write('  ' + season + ': ')
            sys.stdout.flush()

            matches = scrape_page(page_name)

            if matches:
                inserted = insert_matches(conn, league_code, season, matches)
                total_inserted += inserted
                league_inserted += inserted
                print(str(inserted) + ' new matches')
            else:
                print('no data')
                time.sleep(0.3)

            time.sleep(0.5)

        if league_inserted == 0:
            failures.append(league_code + ' (' + league_name + ')')

        conn.commit()

    conn.close()
    print()
    print('=' * 70)
    print('RESULTS')
    print('=' * 70)
    print('Leagues processed: ' + str(total_leagues))
    print('Total new matches: ' + str(total_inserted))
    if failures:
        print()
        print('Leagues with no data:')
        for f in failures:
            print('  - ' + f)
    print()
    print('Done!')

if __name__ == '__main__':
    main()
