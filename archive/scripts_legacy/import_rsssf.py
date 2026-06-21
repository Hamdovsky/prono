"""
Import missing leagues from RSSSF (Rec.Sport.Soccer Statistics Foundation).
Covers: Uruguay, Chile, Bolivia, Angola, Mali, Senegal
"""
import re, sqlite3, time, sys, urllib.request, urllib.parse

HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
DB_PATH = 'data/historical_archive.sqlite'

# RSSSF URL patterns: https://www.rsssf.org/tables{letter}/{code}{year}.html
LEAGUES = [
    ('URU', 'Uruguay Primera',      'tablesu/uru', True),
    ('CHI', 'Chile Primera',        'tablesc/chile', True),
    ('BOL', 'Bolivia Primera',      'tablesb/bol', True),
    ('AGO', 'Angola Girabola',      'tablesa/ango', True),
    ('MLI', 'Mali Premiere',        'tablesm/mali', True),
]

def gen_seasons(use_year):
    if use_year:
        for y in range(2025, 2014, -1):
            yield str(y)
    else:
        for y in range(2025, 2014, -1):
            prev = y - 1
            yield str(prev) + '-' + str(y)[-2:]

def fetch_rsssf(url):
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        html = urllib.request.urlopen(req, timeout=15).read().decode('utf-8', errors='replace')
        return html
    except:
        return None

def parse_rsssf_matches(html):
    """Parse match results from RSSSF <pre> blocks"""
    pre_blocks = re.findall(r'<pre>(.*?)</pre>', html, re.DOTALL)
    if not pre_blocks:
        return []

    matches = []
    team_names = set()

    for block in pre_blocks:
        lines = block.strip().split('\n')
        in_round = False
        date_str = ''

        for line in lines:
            line_stripped = line.strip()
            if not line_stripped:
                continue

            # Round header
            if re.match(r'^Round\s+\d+', line_stripped, re.IGNORECASE):
                in_round = True
                continue

            # Date line: [Month Day] or [Month Day-Year]
            date_match = re.match(r'^\[(\w+\s+\d+(?:[–-]\d+)?)\]', line_stripped)
            if date_match:
                date_str = date_match.group(1)
                continue

            # Skip table lines (start with digit + dot, like "1.Team")
            if re.match(r'^\d+\.', line_stripped):
                continue
            if re.match(r'^\s{0,2}\d+\s', line_stripped) and not re.match(r'^\s*\d+[–-]\d+\s', line_stripped):
                if re.match(r'^\s{0,2}\d+\.?\s{1,3}[A-Z]', line_stripped):
                    continue

            # Skip scorer lines (start with whitespace + [ or just [)
            if line_stripped.startswith('[') and ';' in line_stripped:
                continue
            if line.startswith('  ') and line_stripped.startswith('['):
                continue

            # Skip HTML tags, navigation, section headers
            if '<a' in line_stripped or '</a>' in line_stripped or line_stripped.startswith('<'):
                continue
            if line_stripped.startswith('NB:'):
                continue

            # Match pattern: TeamName  X-Y  TeamName
            # Match pattern allows optional [note] after score
            match = re.match(
                r'^\s*([A-Za-z\u00C0-\u024F\'\-\s\.\(\)&]+?)\s+'
                r'(\d+)[\u2013\-](\d+)\s+'
                r'([A-Za-z\u00C0-\u024F\'\-\s\.\(\)&]+?)\s*(?:\[.*?\]|\s*)$',
                line_stripped
            )
            if match:
                home = match.group(1).strip()
                sh = int(match.group(2))
                sa = int(match.group(3))
                away = match.group(4).strip()

                if not home or not away:
                    continue
                if home == away:
                    continue

                result = 'H' if sh > sa else ('A' if sa > sh else 'D')
                matches.append((home, away, sh, sa, result))
                team_names.add(home)
                team_names.add(away)

    return matches

def insert_matches(conn, league_code, season_code, matches):
    if not matches:
        return 0
    cur = conn.cursor()
    count = 0
    for home, away, sh, sa, result in matches:
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
    print('RSSSF Historical Match Importer')
    print('=' * 60)

    for league_code, league_name, path_prefix, use_year in LEAGUES:
        print(f'\n--- {league_code}: {league_name} ---')
        league_inserted = 0

        for season in gen_seasons(use_year):
            url = f'https://www.rsssf.org/{path_prefix}{season}.html'

            # Skip if already has data
            cur.execute("SELECT COUNT(*) FROM archive_football_data WHERE league_code=? AND season_code=?",
                        (league_code, season))
            if cur.fetchone()[0] > 10:
                print(f'  {season}: already has data (skip)')
                continue

            sys.stdout.write(f'  {season}: ')
            sys.stdout.flush()

            html = fetch_rsssf(url)
            if not html:
                print('404')
                time.sleep(0.3)
                continue

            matches = parse_rsssf_matches(html)
            if matches:
                inserted = insert_matches(conn, league_code, season, matches)
                total_inserted += inserted
                league_inserted += inserted
                print(f'{inserted} matches (from {len(matches)} found)')
            else:
                print('parsed 0 matches')
                # Debug: save HTML sample
                with open(f'tmp/rsssf_{league_code}_{season}_debug.html', 'w', encoding='utf-8') as f:
                    f.write(html[:5000])

            time.sleep(0.5)

        if league_inserted == 0:
            print(f'  ** No data found for {league_code}')

        conn.commit()

    conn.close()
    print(f'\nTotal new matches: {total_inserted}')
    print('Done!')

if __name__ == '__main__':
    main()
