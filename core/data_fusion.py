#!/usr/bin/env python3
"""
data_fusion.py - Team Name Alignment & Dataset Fusion Pipeline
===============================================================
Fuse 212K Pinnacle odds + 180K xG stats + WC2026 squad data
with 49K international_results for premium V553 training.

Pipeline:
  1. Team Name Normalization (fuzzy + manual overrides)
  2. Match international_results -> soccer_fixtures by date + team
  3. Inject Pinnacle odds from soccer_odds
  4. Inject xG/stats from soccer_match_stats
  5. Add WC2026 squad features (market value, age, fifa_rank)
  6. Export v553_wc2026_premium.csv

Usage:
  python core/data_fusion.py
"""

import os
import sys
import json
import csv
import sqlite3
import math
from datetime import datetime, timedelta
from difflib import SequenceMatcher

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, 'data', 'historical_archive.sqlite')
OUTPUT_CSV = os.path.join(BASE_DIR, 'data', 'v553_wc2026_premium.csv')
MAPPING_CACHE = os.path.join(BASE_DIR, 'data', 'team_name_mapping.json')
STATS_DIR = os.path.join(BASE_DIR, 'data')

# ============================================================
# 1. TEAM NAME NORMALIZATION
# ============================================================

YOUTH_SUFFIXES = [' u23', ' u21', ' u20', ' u19', ' u18', ' u17', ' u22', ' u16']

# Overrides for matching international_results -> soccer_teams
# Targets MUST be actual soccer_teams names (verified against DB)
SOCCER_TEAMS_MAP = {
    'usa': 'USA', 'us': 'USA', 'united states': 'USA',
    'united states of america': 'USA',
    'republic of ireland': 'Rep. Of Ireland', 'ireland': 'Rep. Of Ireland',
    'north macedonia': 'FYR Macedonia', 'fyr macedonia': 'FYR Macedonia',
    'cape verde': 'Cape Verde Islands', 'cape verde islands': 'Cape Verde Islands',
    'cabo verde': 'Cape Verde Islands', 'cabo verde islands': 'Cape Verde Islands',
    'dr congo': 'Congo DR', 'congo dr': 'Congo DR',
    'democratic republic of the congo': 'Congo DR',
    "cote d'ivoire": 'Ivory Coast', 'ivory coast': 'Ivory Coast',
    'korea republic': 'South Korea',
    'saint lucia': 'St. Lucia', 'st. lucia': 'St. Lucia',
    'saint kitts and nevis': 'St. Kitts and Nevis',
    'st. kitts and nevis': 'St. Kitts and Nevis',
    'saint vincent and the grenadines': 'St. Vincent / Grenadines',
    'st. vincent and the grenadines': 'St. Vincent / Grenadines',
    'bosnia and herzegovina': 'Bosnia & Herzegovina', 'bosnia': 'Bosnia & Herzegovina',
    'viet nam': 'Vietnam',
    'china pr': 'China', 'rv of china': 'China',
    'ir iran': 'Iran',
    'guinea bissau': 'Guinea-Bissau',
    'timor leste': 'Timor-Leste', 'east timor': 'Timor-Leste',
    'eswatini': 'Eswatini', 'swaziland': 'Eswatini',
    'czechia': 'Czech Republic',
    'saudi arabia': 'Saudi Arabia',
    'united arab emirates': 'United Arab Emirates',
    'chinese taipei': 'Chinese Taipei', 'taiwan': 'Chinese Taipei',
}

# Manual overrides for WC2026 team name matching
# Format: {normalized_name: wc2026_team_name}
MANUAL_MAP = {
    'usa': 'United States',
    'us': 'United States',
    'united states of america': 'United States',
    'korea republic': 'South Korea',
    'south korea': 'South Korea',
    'korea dpr': 'North Korea',
    'north korea': 'North Korea',
    'ivory coast': "Cote d'Ivoire",
    "cote d'ivoire": "Cote d'Ivoire",
    'dr congo': 'Congo DR',
    'congo dr': 'Congo DR',
    'democratic republic of the congo': 'Congo DR',
    'cape verde': 'Cape Verde',
    'cape verde islands': 'Cape Verde',
    'cabo verde': 'Cape Verde',
    'rv of china': 'China PR',
    "china pr": 'China PR',
    'china': 'China PR',
    'chinese taipei': 'Chinese Taipei',
    'taiwan': 'Chinese Taipei',
    'east timor': 'Timor-Leste',
    'timor leste': 'Timor-Leste',
    'iran': 'IR Iran',
    'iran pr': 'IR Iran',
    'syria': 'Syria PR',
    'syrian arab republic': 'Syria PR',
    'vietnam': 'Viet Nam',
    'laos': 'Lao PR',
    'myanmar': 'Myanmar PR',
    'philippines': 'Philippines PR',
    'tanzania': 'Tanzania PR',
    'zimbabwe': 'Zimbabwe PR',
    'kenya': 'Kenya PR',
    'malawi': 'Malawi PR',
    'mozambique': 'Mozambique PR',
    'rwanda': 'Rwanda PR',
    'uganda': 'Uganda PR',
    'zambia': 'Zambia PR',
    'burkina faso': "Burkina Faso PR",
    'mali': 'Mali PR',
    'niger': 'Niger PR',
    'senegal': 'Senegal PR',
    'gambia': 'Gambia PR',
    'sierra leone': 'Sierra Leone PR',
    'ghana': 'Ghana PR',
    'nigeria': 'Nigeria PR',
    'cameroon': 'Cameroon PR',
    'congo': 'Congo PR',
    'benin': 'Benin PR',
    'togo': 'Togo PR',
    'liberia': 'Liberia PR',
    'guinea': 'Guinea PR',
    'guinea bissau': 'Guinea Bissau PR',
    'equatorial guinea': 'Equatorial Guinea PR',
    'gabon': 'Gabon PR',
    'angola': 'Angola PR',
    'south africa': 'South Africa PR',
    'namibia': 'Namibia PR',
    'botswana': 'Botswana PR',
    'sudan': 'Sudan PR',
    'south sudan': 'South Sudan PR',
    'ethiopia': 'Ethiopia PR',
    'eritrea': 'Eritrea PR',
    'djibouti': 'Djibouti PR',
    'somalia': 'Somalia PR',
    'central african republic': 'Central African Republic',
    'chad': 'Chad PR',
    'mauritania': 'Mauritania PR',
    'morocco': 'Morocco PR',
    'tunisia': 'Tunisia PR',
    'algeria': 'Algeria PR',
    'libya': 'Libya PR',
    'egypt': 'Egypt PR',
    'mauritius': 'Mauritius PR',
    'seychelles': 'Seychelles PR',
    'comoros': 'Comoros PR',
    'sao tome': 'Sao Tome and Principe',
    'sao tome e principe': 'Sao Tome and Principe',
    'saint helena': 'Saint Helena',
    'lesotho': 'Lesotho PR',
    'eswatini': 'Eswatini PR',
    'swaziland': 'Eswatini PR',
    'burundi': 'Burundi PR',
}

def normalize_name(name):
    if not name:
        return ''
    n = str(name).strip().lower()
    for suffix in [' national team', ' nt', ' (national)', ' fc', ' (f)']:
        if n.endswith(suffix):
            n = n[:-len(suffix)].strip()
    n = n.replace('st. ', 'saint ').replace('st ', 'saint ')
    return n

def fuzzy_match(name, candidates, manual_map=None, threshold=0.80):
    n = normalize_name(name)
    if not n:
        return None, 0.0
    exact_lookup = {}
    for c in candidates:
        exact_lookup[normalize_name(c)] = c
    if n in exact_lookup:
        return exact_lookup[n], 1.0
    if manual_map and n in manual_map:
        mapped = manual_map[n]
        norm_mapped = normalize_name(mapped)
        if norm_mapped in exact_lookup:
            return exact_lookup[norm_mapped], 1.0
        return mapped, 0.95
    best_score = 0.0
    best_candidate = None
    is_source_youth = any(n.endswith(ys) for ys in YOUTH_SUFFIXES)
    for c in candidates:
        cn = normalize_name(c)
        score = SequenceMatcher(None, n, cn).ratio()
        if not is_source_youth and any(cn.endswith(ys) for ys in YOUTH_SUFFIXES):
            score *= 0.3
        if score > best_score:
            best_score = score
            best_candidate = c
    if best_score >= threshold:
        return best_candidate, best_score
    return None, best_score

def build_name_mapping(conn):
    cache_path = MAPPING_CACHE
    if os.path.exists(cache_path):
        try:
            with open(cache_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass

    intl_rows = conn.execute(
        "SELECT DISTINCT home_team FROM international_results "
        "UNION SELECT DISTINCT away_team FROM international_results"
    ).fetchall()
    intl_names = sorted(set(r[0] for r in intl_rows if r[0]))

    soccer_rows = conn.execute("SELECT id, name FROM soccer_teams").fetchall()
    soccer_names = {r['id']: r['name'] for r in soccer_rows}
    all_soccer_names = list(soccer_names.values())

    wc_rows = conn.execute("SELECT team_name FROM wc2026_teams").fetchall()
    wc_names = [r[0] for r in wc_rows if r[0]]

    mapping = {}
    for intl_name in intl_names:
        best_name, best_score = fuzzy_match(intl_name, all_soccer_names, manual_map=SOCCER_TEAMS_MAP)
        if best_name:
            soccer_id = None
            for sid, sname in soccer_names.items():
                if sname == best_name:
                    soccer_id = sid
                    break
            mapping[intl_name] = {
                'soccer_name': best_name,
                'soccer_id': soccer_id,
                'match_score': round(best_score, 4)
            }
        else:
            mapping[intl_name] = {
                'soccer_name': None,
                'soccer_id': None,
                'match_score': 0.0
            }

    wc_mapping = {}
    for intl_name in intl_names:
        best_wc, wc_score = fuzzy_match(intl_name, wc_names, manual_map=MANUAL_MAP)
        if best_wc:
            wc_mapping[intl_name] = {
                'wc_name': best_wc,
                'match_score': round(wc_score, 4)
            }
        else:
            wc_mapping[intl_name] = {'wc_name': None, 'match_score': 0.0}

    result = {
        'intl_to_soccer': mapping,
        'intl_to_wc': wc_mapping,
        'intl_names': intl_names,
    }

    try:
        with open(cache_path, 'w', encoding='utf-8') as f:
            json.dump({
                'intl_to_soccer': {k: v for k, v in mapping.items() if v['soccer_name']},
                'intl_to_wc': {k: v for k, v in wc_mapping.items() if v['wc_name']},
                'intl_names': intl_names,
            }, f, indent=2, ensure_ascii=False)
    except Exception:
        pass

    return result

# ============================================================
# 2. FIND INTERNATIONAL LEAGUES IN SOCCER-DATASET
# ============================================================

def find_international_league_ids(conn):
    intl_keywords = [
        'world cup', 'euro', 'copa', 'nations league', 'friendly',
        'international', 'african cup', 'asian cup', 'gold cup',
        'concacaf', 'conmebol', 'uefa', 'fifa',
        'tournament', 'championship',
    ]
    league_ids = set()
    try:
        rows = conn.execute(
            "SELECT id, name, country FROM soccer_leagues "
            "WHERE LOWER(country) = 'world' OR LOWER(country) = 'international'"
        ).fetchall()
        for r in rows:
            league_ids.add(r['id'])
        extra = conn.execute(
            "SELECT id, name, country FROM soccer_leagues "
            "WHERE LOWER(name) LIKE '%cup%' OR LOWER(name) LIKE '%euro%' "
            "OR LOWER(name) LIKE '%friendly%'"
        ).fetchall()
        for r in extra:
            nl = r['name'].lower()
            if any(kw in nl for kw in intl_keywords):
                league_ids.add(r['id'])
    except Exception:
        pass
    return league_ids

# ============================================================
# 3. BUILD FIXTURE INDEX (GROUPED BY DATE)
# ============================================================

def load_soccer_fixtures_by_date(conn, league_ids):
    if not league_ids:
        return {}
    placeholders = ','.join('?' * len(league_ids))
    query = (
        "SELECT f.id, f.date, f.league_id, f.home_team_id, f.away_team_id, "
        "f.goals_home, f.goals_away, f.status, "
        "th.name AS home_team_name, ta.name AS away_team_name "
        "FROM soccer_fixtures f "
        "LEFT JOIN soccer_teams th ON f.home_team_id = th.id "
        "LEFT JOIN soccer_teams ta ON f.away_team_id = ta.id "
        f"WHERE f.league_id IN ({placeholders}) "
        "AND f.status = 'FT' AND f.goals_home IS NOT NULL"
    )
    rows = conn.execute(query, list(league_ids)).fetchall()
    fixtures_by_date = {}
    for r in rows:
        d = str(r['date'])[:10] if r['date'] else ''
        if not d:
            continue
        if d not in fixtures_by_date:
            fixtures_by_date[d] = []
        fixtures_by_date[d].append({
            'id': r['id'],
            'date': d,
            'league_id': r['league_id'],
            'home_team_id': r['home_team_id'],
            'away_team_id': r['away_team_id'],
            'home_team_name': r['home_team_name'],
            'away_team_name': r['away_team_name'],
            'goals_home': r['goals_home'],
            'goals_away': r['goals_away'],
        })
    return fixtures_by_date

# ============================================================
# 4. LOAD ODDS + STATS
# ============================================================

def load_all_odds(conn):
    odds = {}
    rows = conn.execute(
        "SELECT fixture_id, bookmaker, home_win, draw, away_win FROM soccer_odds"
    ).fetchall()
    for r in rows:
        fid = r['fixture_id']
        if fid not in odds:
            odds[fid] = {}
        bm = r['bookmaker']
        priority = {'Pinnacle': 0, 'Bet365': 1, 'Betfair': 2}.get(bm, 9)
        if bm not in odds[fid] or priority < odds[fid].get('_priority', 99):
            odds[fid] = {
                'odds_home': r['home_win'],
                'odds_draw': r['draw'],
                'odds_away': r['away_win'],
                'bookmaker': bm,
                '_priority': priority,
            }
    return odds

def load_match_stats(conn):
    stats = {}
    rows = conn.execute(
        "SELECT fixture_id, home_shots_total, away_shots_total, "
        "home_shots_on_goal, away_shots_on_goal, "
        "home_shots_inside_box, away_shots_inside_box, "
        "home_corners, away_corners, "
        "home_fouls, away_fouls, "
        "home_yellow_cards, away_yellow_cards, "
        "home_red_cards, away_red_cards, "
        "home_possession, away_possession, "
        "home_xg, away_xg "
        "FROM soccer_match_stats"
    ).fetchall()
    for r in rows:
        stats[r['fixture_id']] = dict(r)
    return stats

# ============================================================
# 5. WC2026 SQUAD DATA CACHE
# ============================================================

def load_wc2026_squad_data(conn):
    squad = {}
    rows = conn.execute(
        "SELECT team_name, fifa_rank, fifa_points, total_market_value_eur, "
        "squad_size, average_age, confederation FROM wc2026_teams"
    ).fetchall()
    for r in rows:
        name = str(r['team_name']).strip()
        squad[name] = {
            'fifa_rank': r['fifa_rank'] if r['fifa_rank'] is not None else 999,
            'fifa_points': r['fifa_points'] if r['fifa_points'] is not None else 0,
            'squad_value': r['total_market_value_eur'] if r['total_market_value_eur'] is not None else 0,
            'squad_size': r['squad_size'] if r['squad_size'] is not None else 0,
            'avg_age': r['average_age'] if r['average_age'] is not None else 27.0,
            'confederation': str(r['confederation'] or ''),
        }
    return squad

# ============================================================
# 6. MAIN FUSION PIPELINE
# ============================================================

def match_intl_to_fixture(intl_home, intl_away, fixtures_on_date, name_mapping):
    intl_to_soccer = name_mapping['intl_to_soccer']
    home_info = intl_to_soccer.get(intl_home, {})
    away_info = intl_to_soccer.get(intl_away, {})
    home_soccer_id = home_info.get('soccer_id')
    away_soccer_id = away_info.get('soccer_id')
    home_soccer_name = home_info.get('soccer_name')
    away_soccer_name = away_info.get('soccer_name')

    for fx in fixtures_on_date:
        if fx['home_team_id'] == home_soccer_id and fx['away_team_id'] == away_soccer_id:
            return fx, 1.0
        if fx['home_team_id'] == away_soccer_id and fx['away_team_id'] == home_soccer_id:
            return fx, 1.0

    h_norm = normalize_name(intl_home)
    a_norm = normalize_name(intl_away)
    for fx in fixtures_on_date:
        fhn = normalize_name(fx['home_team_name'])
        fan = normalize_name(fx['away_team_name'])
        if (h_norm == fhn and a_norm == fan) or (h_norm == fan and a_norm == fhn):
            return fx, 0.95
    best_score = 0.0
    best_fx = None
    for fx in fixtures_on_date:
        fhn = normalize_name(fx['home_team_name'])
        fan = normalize_name(fx['away_team_name'])
        s1 = SequenceMatcher(None, h_norm, fhn).ratio() + SequenceMatcher(None, a_norm, fan).ratio()
        s2 = SequenceMatcher(None, h_norm, fan).ratio() + SequenceMatcher(None, a_norm, fhn).ratio()
        score = max(s1, s2) / 2.0
        if score > best_score:
            best_score = score
            best_fx = fx
    if best_score >= 0.75:
        return best_fx, best_score
    return None, 0.0

def get_wc_squad_features(home_team, away_team, name_mapping, wc_squad):
    intl_to_wc = name_mapping['intl_to_wc']
    home_wc = intl_to_wc.get(home_team, {}).get('wc_name')
    away_wc = intl_to_wc.get(away_team, {}).get('wc_name')

    features = {
        'fifa_rank_h': 999, 'fifa_rank_a': 999,
        'fifa_points_h': 0, 'fifa_points_a': 0,
        'squad_value_h': 0, 'squad_value_a': 0,
        'squad_size_h': 0, 'squad_size_a': 0,
        'avg_age_h': 27.0, 'avg_age_a': 27.0,
        'confederation_h': '', 'confederation_a': '',
    }

    if home_wc and home_wc in wc_squad:
        d = wc_squad[home_wc]
        features.update({
            'fifa_rank_h': d['fifa_rank'],
            'fifa_points_h': d['fifa_points'],
            'squad_value_h': d['squad_value'],
            'squad_size_h': d['squad_size'],
            'avg_age_h': d['avg_age'],
            'confederation_h': d['confederation'],
        })

    if away_wc and away_wc in wc_squad:
        d = wc_squad[away_wc]
        features.update({
            'fifa_rank_a': d['fifa_rank'],
            'fifa_points_a': d['fifa_points'],
            'squad_value_a': d['squad_value'],
            'squad_size_a': d['squad_size'],
            'avg_age_a': d['avg_age'],
            'confederation_a': d['confederation'],
        })

    return features

def compute_elo_lookup(intl_matches):
    """Compute Elo ratings chronologically and return {(date, home, away): (elo_h, elo_a)}"""
    elo = {}
    lookup = {}
    for md in intl_matches:
        d = dict(md)
        date_str = str(d.get('date', ''))[:10] if d.get('date') else ''
        home = str(d.get('home_team', '')).strip()
        away = str(d.get('away_team', '')).strip()
        if not date_str or not home or not away:
            continue
        if home not in elo:
            elo[home] = 1500
        if away not in elo:
            elo[away] = 1500
        h_rating = elo[home]
        a_rating = elo[away]
        lookup[(date_str, home, away)] = (h_rating, a_rating)
        h_expected = 1 / (1 + 10 ** ((a_rating - h_rating) / 400))
        a_expected = 1 - h_expected
        h_goals = d.get('home_score')
        a_goals = d.get('away_score')
        if h_goals is not None and a_goals is not None:
            if h_goals > a_goals:
                h_actual, a_actual = 1, 0
            elif h_goals < a_goals:
                h_actual, a_actual = 0, 1
            else:
                h_actual, a_actual = 0.5, 0.5
            k = 32
            elo[home] = h_rating + k * (h_actual - h_expected)
            elo[away] = a_rating + k * (a_actual - a_expected)
    return lookup

def run_fusion():
    print("=" * 60)
    print("  DATA FUSION PIPELINE — v553 Premium Dataset")
    print("=" * 60)

    if not os.path.exists(DB_PATH):
        print(f"[FATAL] Database not found: {DB_PATH}")
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # -------------------------------------------------------
    # Step 1: Build Team Name Mapping
    # -------------------------------------------------------
    print("\n[1/6] Building team name mapping...")
    name_mapping = build_name_mapping(conn)
    intl_names = name_mapping['intl_names']
    matched = sum(1 for v in name_mapping['intl_to_soccer'].values() if v.get('soccer_name'))
    wc_matched = sum(1 for v in name_mapping['intl_to_wc'].values() if v.get('wc_name'))
    print(f"       {len(intl_names)} international teams, {matched} matched to soccer_teams, {wc_matched} matched to WC2026")

    # -------------------------------------------------------
    # Step 2: Find International Leagues
    # -------------------------------------------------------
    print("\n[2/6] Finding international competition leagues...")
    intl_league_ids = find_international_league_ids(conn)
    print(f"       Found {len(intl_league_ids)} international league IDs")

    if intl_league_ids:
        league_names = conn.execute(
            f"SELECT id, name, country FROM soccer_leagues WHERE id IN ({','.join('?'*len(intl_league_ids))})",
            list(intl_league_ids)
        ).fetchall()
        for ln in league_names:
            print(f"         - {ln['name']} ({ln['country']})")

    # -------------------------------------------------------
    # Step 3: Load Fixtures Index
    # -------------------------------------------------------
    print("\n[3/6] Loading soccer fixtures (international only)...")
    fixtures_by_date = load_soccer_fixtures_by_date(conn, intl_league_ids)
    total_fixtures = sum(len(v) for v in fixtures_by_date.values())
    print(f"       Loaded {total_fixtures} international fixtures across {len(fixtures_by_date)} dates")

    # -------------------------------------------------------
    # Step 4: Load Odds + Stats
    # -------------------------------------------------------
    print("\n[4/6] Loading Pinnacle odds and xG stats...")
    all_odds = load_all_odds(conn)
    match_stats = load_match_stats(conn)
    trusted = sum(1 for v in all_odds.values() if v.get('_priority', 99) < 3)
    print(f"       {len(all_odds)} unique fixtures with odds ({trusted} Pinnacle/Bet365/Betfair), {len(match_stats)} stat entries")

    # -------------------------------------------------------
    # Step 5: Load WC2026 Squad Data
    # -------------------------------------------------------
    print("\n[5/6] Loading WC2026 squad features...")
    wc_squad = load_wc2026_squad_data(conn)
    print(f"       {len(wc_squad)} teams in WC2026 squad cache")

    # -------------------------------------------------------
    # Step 6: Process International Matches
    # -------------------------------------------------------
    print("\n[6/6] Processing international matches with enrichment...")
    intl_matches = conn.execute(
        "SELECT date, home_team, away_team, home_score, away_score, tournament, city, country, neutral "
        "FROM international_results "
        "WHERE home_score IS NOT NULL "
        "ORDER BY date"
    ).fetchall()
    print(f"       Processing {len(intl_matches)} international matches...")

    # Compute Elo ratings (chronological)
    print("       Computing Elo ratings from international_results...")
    elo_lookup = compute_elo_lookup(intl_matches)
    print(f"       Computed Elo ratings for {len(elo_lookup)} match instances")

    output_rows = []
    matched_count = 0
    odds_fused = 0
    stats_fused = 0
    squad_fused = 0
    skipped = 0

    for idx, match in enumerate(intl_matches):
        md = dict(match)
        date_str = str(md.get('date', ''))[:10] if md.get('date') else ''
        home_team = str(md.get('home_team', '')).strip()
        away_team = str(md.get('away_team', '')).strip()
        tournament = str(md.get('tournament', '')).strip()
        neutral = 1 if (str(md.get('neutral', '0')).upper() == 'TRUE' or str(md.get('neutral', '0')) == '1') else 0

        if not date_str:
            skipped += 1
            continue

        row = {
            'date': date_str,
            'home_team': home_team,
            'away_team': away_team,
            'tournament': tournament,
            'home_score': md.get('home_score'),
            'away_score': md.get('away_score'),
            'city': str(md.get('city', '')),
            'country': str(md.get('country', '')),
            'neutral': neutral,
            'fixture_id': '',
            'match_confidence': 0.0,
            'odds_home': '',
            'odds_draw': '',
            'odds_away': '',
            'odds_bookmaker': '',
            'home_possession': '',
            'away_possession': '',
            'home_shots_total': '',
            'away_shots_total': '',
            'home_shots_on_goal': '',
            'away_shots_on_goal': '',
            'home_shots_inside_box': '',
            'away_shots_inside_box': '',
            'home_corners': '',
            'away_corners': '',
            'home_fouls': '',
            'away_fouls': '',
            'home_yellow_cards': '',
            'away_yellow_cards': '',
            'home_red_cards': '',
            'away_red_cards': '',
            'home_xg': '',
            'away_xg': '',
            'elo_h': '',
            'elo_a': '',
            'fifa_rank_h': 999,
            'fifa_rank_a': 999,
            'fifa_points_h': 0,
            'fifa_points_a': 0,
            'squad_value_h': 0,
            'squad_value_a': 0,
            'squad_size_h': 0,
            'squad_size_a': 0,
            'avg_age_h': 27.0,
            'avg_age_a': 27.0,
            'confederation_h': '',
            'confederation_a': '',
        }

        # Look up pre-match Elo ratings
        elo_key = (date_str, home_team, away_team)
        if elo_key in elo_lookup:
            row['elo_h'], row['elo_a'] = elo_lookup[elo_key]

        # Try to match to soccer fixture
        fixtures_today = fixtures_by_date.get(date_str, [])
        if fixtures_today:
            matched_fx, conf = match_intl_to_fixture(
                home_team, away_team, fixtures_today, name_mapping
            )
            if matched_fx:
                matched_count += 1
                row['fixture_id'] = str(matched_fx['id'])
                row['match_confidence'] = round(conf, 4)

                fx_id = matched_fx['id']

                # Inject odds (Pinnacle > Bet365 > Betfair > any)
                if fx_id in all_odds:
                    odds_fused += 1
                    od = all_odds[fx_id]
                    row['odds_home'] = od['odds_home']
                    row['odds_draw'] = od['odds_draw']
                    row['odds_away'] = od['odds_away']
                    row['odds_bookmaker'] = od.get('bookmaker', '')

                # Inject xG stats
                if fx_id in match_stats:
                    stats_fused += 1
                    st = match_stats[fx_id]
                    for col in ['home_possession', 'away_possession',
                                'home_shots_total', 'away_shots_total',
                                'home_shots_on_goal', 'away_shots_on_goal',
                                'home_shots_inside_box', 'away_shots_inside_box',
                                'home_corners', 'away_corners',
                                'home_fouls', 'away_fouls',
                                'home_yellow_cards', 'away_yellow_cards',
                                'home_red_cards', 'away_red_cards',
                                'home_xg', 'away_xg']:
                        raw = st.get(col)
                        if raw is not None:
                            row[col] = raw

        # Inject WC2026 squad features
        sf = get_wc_squad_features(home_team, away_team, name_mapping, wc_squad)
        if sf['fifa_rank_h'] < 999 or sf['fifa_rank_a'] < 999:
            squad_fused += 1
        for k, v in sf.items():
            row[k] = v

        output_rows.append(row)

        if (idx + 1) % 5000 == 0:
            print(f"       ... Processed {idx + 1}/{len(intl_matches)} matches "
                  f"(matched: {matched_count}, odds: {odds_fused}, stats: {stats_fused}, squad: {squad_fused})")

    conn.close()

    # -------------------------------------------------------
    # Export CSV
    # -------------------------------------------------------
    fieldnames = [
        'date', 'home_team', 'away_team', 'tournament',
        'home_score', 'away_score', 'city', 'country', 'neutral',
        'fixture_id', 'match_confidence',
        'odds_home', 'odds_draw', 'odds_away', 'odds_bookmaker',
        'elo_h', 'elo_a',
        'home_possession', 'away_possession',
        'home_shots_total', 'away_shots_total',
        'home_shots_on_goal', 'away_shots_on_goal',
        'home_shots_inside_box', 'away_shots_inside_box',
        'home_corners', 'away_corners',
        'home_fouls', 'away_fouls',
        'home_yellow_cards', 'away_yellow_cards',
        'home_red_cards', 'away_red_cards',
        'home_xg', 'away_xg',
        'fifa_rank_h', 'fifa_rank_a',
        'fifa_points_h', 'fifa_points_a',
        'squad_value_h', 'squad_value_a',
        'squad_size_h', 'squad_size_a',
        'avg_age_h', 'avg_age_a',
        'confederation_h', 'confederation_a',
    ]

    os.makedirs(os.path.dirname(OUTPUT_CSV), exist_ok=True)
    with open(OUTPUT_CSV, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in output_rows:
            writer.writerow(row)

    # -------------------------------------------------------
      # Summary Report
    # -------------------------------------------------------
    print("\n" + "=" * 60)
    print("  FUSION COMPLETE — Summary")
    print("=" * 60)
    print(f"  Total international matches processed: {len(output_rows)}")
    print(f"  Matched to soccer fixtures:           {matched_count} ({100*matched_count/len(output_rows):.1f}%)" if output_rows else "  Matched to soccer fixtures:           0")
    print(f"  Odds injected:                         {odds_fused} ({100*odds_fused/len(output_rows):.1f}%)" if output_rows else "  Odds injected:                         0")
    print(f"  xG stats injected:                     {stats_fused} ({100*stats_fused/len(output_rows):.1f}%)" if output_rows else "  xG stats injected:                     0")
    print(f"  WC2026 squad features:                 {squad_fused} matches enriched")
    print(f"  Skipped (no date):                     {skipped}")
    print(f"\n  Output: {OUTPUT_CSV}")

    stats_with_odds = sum(1 for r in output_rows if r['odds_home'] != '')
    stats_with_xg = sum(1 for r in output_rows if r['home_xg'] != '')
    bookmaker_counts = {}
    for r in output_rows:
        bm = r.get('odds_bookmaker', '')
        if bm:
            bookmaker_counts[bm] = bookmaker_counts.get(bm, 0) + 1
    print(f"\n  Coverage breakdown:")
    print(f"    With odds:          {stats_with_odds}/{len(output_rows)} ({100*stats_with_odds/len(output_rows):.1f}%)" if output_rows else "    With odds:          0/0 (0%)")
    if bookmaker_counts:
        for bm, cnt in sorted(bookmaker_counts.items(), key=lambda x: -x[1]):
            print(f"      {bm}: {cnt}")
    print(f"    With xG data:        {stats_with_xg}/{len(output_rows)} ({100*stats_with_xg/len(output_rows):.1f}%)" if output_rows else "    With xG data:        0/0 (0%)")
    print(f"    With FIFA rank:      {sum(1 for r in output_rows if r['fifa_rank_h'] < 999 or r['fifa_rank_a'] < 999)}/{len(output_rows)}" if output_rows else "    With FIFA rank:      0/0")
    print("=" * 60)

    return output_rows

# ============================================================
# PREVIEW: Show sample rows
# ============================================================

def show_sample(rows, n=5):
    if not rows:
        return
    print(f"\nSample rows ({min(n, len(rows))}):")
    for row in rows[:n]:
        status = ''
        if row['odds_home']:
            status += ' [ODDS]'
        if row['home_xg']:
            status += ' [xG]'
        if row['fifa_rank_h'] < 999:
            status += ' [WC]'
        print(f"  {row['date']} | {row['home_team']:25s} vs {row['away_team']:25s} | "
              f"{row['home_score']}-{row['away_score']} | {row['tournament'][:25]:25s}{status}")

# ============================================================
# MAIN
# ============================================================

if __name__ == '__main__':
    rows = run_fusion()
    show_sample(rows, 10)
