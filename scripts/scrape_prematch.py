#!/usr/bin/env python3
"""
scrape_prematch.py — Scraping des matchs pre-match + cotes.

Usage:
  python scripts/scrape_prematch.py              # scrape aujourd'hui
  python scripts/scrape_prematch.py --days 3     # scrape J+3
  python scripts/scrape_prematch.py --all        # scrape toutes les dates dispo

Output:
  data/today_matches.json — matchs avec cotes
  data/odds_history.jsonl — historique cotes (append)
"""

import sys
import os
import json
import time
import argparse
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from curl_cffi import requests as cr


# ─── BetExplorer ────────────────────────────────────────────────────────────────

BETEXPLORER_URL = "https://www.betexplorer.com/gres/soccer/{league}/"
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
}

FINGERPRINTS = ['chrome124', 'chrome120', 'safari17_0', 'firefox133']

LEAGUE_SLUGS = {
    'Premier League': ('england/premier-league', 'e0'),
    ' Championship': ('england/championship', 'e1'),
    'La Liga': ('spain/la-liga', 'sp1'),
    'Segunda Division': ('spain/segunda-division', 'sp2'),
    'Bundesliga': ('germany/bundesliga', 'd1'),
    '2. Bundesliga': ('germany/2-bundesliga', 'd2'),
    'Serie A': ('italy/serie-a', 'i1'),
    'Serie B': ('italy/serie-b', 'i2'),
    'Ligue 1': ('france/ligue-1', 'f1'),
    'Ligue 2': ('france/ligue-2', 'f2'),
    'Eredivisie': ('netherlands/eredivisie', 'n1'),
    'Primeira Liga': ('portugal/primeira-liga', 'p1'),
    'Serie A Brasil': ('brazil/serie-a', 'b1'),
    'Serie B Brasil': ('brazil/serie-b', 'b2'),
    'MLS': ('usa/us-major-league-soccer', 'us1'),
    'Champions League': ('europe/champions-league', 'uefa-cl'),
    'Europa League': ('europe/europa-league', 'uefa-el'),
}

CACHE = {}


def get_betexplorer_odds(home, away, league_slug):
    """Scrape les cotes BetExplorer pour un match."""
    key = f"{home}:{away}:{league_slug}"
    if key in CACHE:
        return CACHE[key]

    url = f"https://www.betexplorer.com/gres/soccer/{league_slug}/"

    for fp in FINGERPRINTS:
        try:
            r = cr.get(url, impersonate=fp, timeout=15, headers=HEADERS)
            if r.status_code != 200:
                continue

            text = r.text
            lines = text.split('\n')

            for line in lines:
                if home.lower() in line.lower() and away.lower() in line.lower():
                    odds_match = _parse_odds_line(line, home, away)
                    if odds_match:
                        CACHE[key] = odds_match
                        return odds_match
        except Exception:
            continue

    CACHE[key] = None
    return None


def _parse_odds_line(line, home, away):
    """Parse une ligne HTML pour extraire les cotes."""
    import re

    try:
        parts = line.split('data-odd=')
        if len(parts) < 4:
            return None

        odds = []
        for p in parts[1:4]:
            m = re.search(r'["\']([\d.]+)["\']', p)
            if m:
                odds.append(float(m.group(1)))
            else:
                odds.append(None)

        if len(odds) >= 3 and odds[0] and odds[1] and odds[2]:
            return {'home': odds[0], 'draw': odds[1], 'away': odds[2]}

        if len(odds) >= 2 and odds[0] and odds[1]:
            return {'home': odds[0], 'draw': None, 'away': odds[1]}

        return None
    except Exception:
        return None


def find_league_slug(league_name):
    """Trouve le slug BetExplorer pour une league."""
    if not league_name:
        return None

    for name, (slug, code) in LEAGUE_SLUGS.items():
        if name.lower() in league_name.lower():
            return slug

    for name, (slug, code) in LEAGUE_SLUGS.items():
        if league_name.lower() in name.lower():
            return slug

    return None


def scrape_league(league_name, date_str):
    """Scrape tous les matchs d'une league pour une date."""
    slug = find_league_slug(league_name)
    if not slug:
        return []

    url = f"https://www.betexplorer.com/gres/soccer/{slug}/"
    matches = []

    for fp in FINGERPRINTS:
        try:
            r = cr.get(url, impersonate=fp, timeout=15, headers=HEADERS)
            if r.status_code != 200:
                continue

            text = r.text
            import re

            tbl_pattern = re.compile(r'data-id="([^"]+)"[^>]*>.*?' + re.escape('px-3 text-right">(\d+):(\d+)'), re.DOTALL)
            matches_found = []

            for m in tbl_pattern.finditer(text):
                match_id = m.group(1)
                score = f"{m.group(2)}-{m.group(3)}"
                matches_found.append({'id': match_id, 'score': score})

            for match in matches_found[:10]:
                matches.append({
                    'league': league_name,
                    'date': date_str,
                    'betexplorer_id': match['id'],
                    'score': match['score'],
                })

            return matches[:10]

        except Exception:
            continue

    return []


# ─── Livescore API ───────────────────────────────────────────────────────────────

LIVESCORE_BASE = 'https://prod-public-api.livescore.com/v1/api/app'


def get_livescore_dates(num_days=3):
    """Récupère les matchs upcoming pour N jours depuis Livescore."""
    all_matches = []
    today = datetime.now()

    for day_offset in range(num_days):
        date = today + timedelta(days=day_offset)
        date_str = date.strftime('%Y-%m-%d')
        ymd = date.strftime('%Y%m%d')

        url = f"{LIVESCORE_BASE}/date/soccer/{ymd}/0?MD=1&countryCode=US&locale=en"

        try:
            r = cr.get(url, impersonate='chrome124', timeout=15, headers={
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json',
            })
            if r.status_code != 200:
                continue

            data = r.json()
            stages = data.get('Stages', [])

            for stage in stages:
                league_name = stage.get('Snm', 'Unknown')
                events = stage.get('Events', [])

                for event in events:
                    eps = event.get('Eps', '')
                    if eps and eps != 'NS':
                        continue

                    home_name = event.get('T1', [{}])[0].get('Nm', '')
                    away_name = event.get('T2', [{}])[0].get('Nm', '')
                    event_id = event.get('Eid', '')
                    esd = event.get('Esd', '')

                    if not home_name or not away_name:
                        continue

                    match = {
                        'id': f"ls_{event_id}",
                        'homeTeam': home_name,
                        'awayTeam': away_name,
                        'league': league_name,
                        'date': date_str,
                        'timestamp': esd,
                        'status': 'scheduled',
                    }
                    all_matches.append(match)

        except Exception as e:
            print(f"  Livescore error for {date_str}: {e}", file=sys.stderr)
            continue

    return all_matches


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Scrape pre-match odds')
    parser.add_argument('--days', type=int, default=3, help='Nombre de jours à scraper')
    parser.add_argument('--all', action='store_true', help='Scrape toutes les dates dispo')
    parser.add_argument('--output', default='data/today_matches.json', help='Output file')
    args = parser.parse_args()

    num_days = 14 if args.all else args.days

    print(f"[scrape_prematch] Scraping {num_days} jours...")

    matches = get_livescore_dates(num_days)
    print(f"[scrape_prematch] {len(matches)} matchs trouvés sur Livescore")

    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    output_file = os.path.join(base_dir, args.output)

    existing = []
    if os.path.exists(output_file):
        try:
            with open(output_file, 'r', encoding='utf-8') as f:
                existing = json.load(f)
        except Exception:
            existing = []

    existing_ids = {m.get('id') for m in existing}

    enriched = []
    for match in matches:
        if match['id'] in existing_ids:
            enriched.append(match)
            continue

        league_slug = find_league_slug(match['league'])
        if league_slug:
            odds = get_betexplorer_odds(match['homeTeam'], match['awayTeam'], league_slug)
            if odds:
                match['odds'] = odds
                print(f"  + {match['homeTeam']} vs {match['awayTeam']}: 1={odds.get('home')} X={odds.get('draw')} 2={odds.get('away')}")
                time.sleep(0.3)
            else:
                print(f"  - {match['homeTeam']} vs {match['awayTeam']}: no odds")

        enriched.append(match)

    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(enriched, f, ensure_ascii=False, indent=2)

    print(f"[scrape_prematch] Saved {len(enriched)} matches to {output_file}")

    history_file = os.path.join(base_dir, 'data', 'odds_history.jsonl')
    if os.path.exists(history_file):
        with open(history_file, 'a', encoding='utf-8') as f:
            for match in enriched:
                if 'odds' in match:
                    record = {
                        'timestamp': datetime.now().isoformat(),
                        'match_id': match['id'],
                        'homeTeam': match['homeTeam'],
                        'awayTeam': match['awayTeam'],
                        'league': match['league'],
                        'date': match['date'],
                        'odds': match['odds'],
                    }
                    f.write(json.dumps(record, ensure_ascii=False) + '\n')
        print(f"[scrape_prematch] Appended odds to {history_file}")


if __name__ == '__main__':
    main()
