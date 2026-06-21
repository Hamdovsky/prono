#!/usr/bin/env python3
"""
db_discover.py --- Full Database & Codebase Discovery for HamdiProno / Stitch
Author: Senior System Architect
Description: Extracts every table, column, league, time range, code feature, and model metadata.
"""

import os, sys, sqlite3, json, re, glob, math

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_ARCHIVE = os.path.join(BASE_DIR, 'data', 'historical_archive.sqlite')
DB_TACTICAL = os.path.join(BASE_DIR, 'data', 'tactical.db')
CORE_DIR = os.path.join(BASE_DIR, 'core')
MODELS_DIR = os.path.join(BASE_DIR, 'models')
DATA_DIR = os.path.join(BASE_DIR, 'data')
SERVICES_DIR = os.path.join(BASE_DIR, 'services')

SEP = "=" * 80
SUB = "-" * 60

def section(title):
    print(f"\n{SEP}")
    print(f"  {title}")
    print(SEP)

def subsection(title):
    print(f"\n{SUB}")
    print(f"  {title}")
    print(SUB)

def fmt_count(n): return f"{n:,}"

# ──────────────────────────────────────────────────────────────
# 1. DATABASE DISCOVERY
# ──────────────────────────────────────────────────────────────

def explore_db(path, label):
    if not os.path.exists(path):
        print(f"\n[SKIP] {label}: File not found at {path}")
        return
    size_mb = os.path.getsize(path) / (1024*1024)
    section(f"DATABASE: {label} ({size_mb:.1f} MB)")

    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # All tables
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    tables = [r['name'] for r in cur.fetchall()]
    print(f"\nTables ({len(tables)}):")
    for t in tables:
        r = conn.execute(f"SELECT COUNT(*) FROM \"{t}\"").fetchone()
        print(f"  - {t}: {fmt_count(r[0])} rows")

    # Schema per table
    subsection("FULL SCHEMA --- Columns per Table")
    for t in tables:
        cur.execute(f"PRAGMA table_info(\"{t}\")")
        cols = cur.fetchall()
        print(f"\n  [{t}] ({len(cols)} columns):")
        for c in cols:
            pk = "PK" if c['pk'] else ""
            nn = "NOT NULL" if c['notnull'] else ""
            dflt = f"default={c['dflt_value']}" if c['dflt_value'] else ""
            print(f"    {c['name']:40s} {c['type']:15s} {pk:4s} {nn:10s} {dflt}")

    conn.close()

def explore_archive():
    if not os.path.exists(DB_ARCHIVE):
        print("[SKIP] No historical_archive.sqlite")
        return

    conn = sqlite3.connect(DB_ARCHIVE)
    conn.row_factory = sqlite3.Row

    # ── Table-specific deep analysis ──
    
    # archive_football_data
    section("DEEP ANALYSIS: archive_football_data")
    r = conn.execute("SELECT MIN(match_date), MAX(match_date) FROM archive_football_data").fetchone()
    total = conn.execute("SELECT COUNT(*) FROM archive_football_data").fetchone()[0]
    print(f"  Total rows: {fmt_count(total)}")
    print(f"  Date range: {r[0]} -> {r[1]}")
    # Leagues
    leagues = conn.execute("SELECT league_code, COUNT(*) as n FROM archive_football_data GROUP BY league_code ORDER BY n DESC").fetchall()
    print(f"\n  Leagues ({len(leagues)}):")
    for l in leagues:
        lname = {'E0':'Premier League','E1':'Championship','E2':'League One','E3':'League Two',
                 'SP1':'La Liga','SP2':'Segunda','D1':'Bundesliga','D2':'2.Bundesliga',
                 'I1':'Serie A','I2':'Serie B','F1':'Ligue 1','F2':'Ligue 2'}.get(l['league_code'], l['league_code'])
        print(f"    {l['league_code']:6s} ({lname:20s}): {fmt_count(l['n']):>8s} matches")
    # Stats availability
    print("\n  Stats availability (2022+):")
    for col in ['shots_home','sot_home','fouls_home','corners_home','yellow_home','red_home']:
        c = conn.execute(f"SELECT COUNT(*) FROM archive_football_data WHERE {col} IS NOT NULL AND match_date >= '2022-01-01'").fetchone()[0]
        print(f"    {col:25s}: {fmt_count(c):>8s} / 8,012")
    # xG availability
    xg_c = conn.execute("SELECT COUNT(*) FROM archive_football_data WHERE xg_home IS NOT NULL AND match_date >= '2022-01-01'").fetchone()[0]
    print(f"    xg_home               : {fmt_count(xg_c):>8s} / 8,012")

    # wc2026_matches
    section("DEEP ANALYSIS: wc2026_matches")
    total = conn.execute("SELECT COUNT(*) FROM wc2026_matches").fetchone()[0]
    scored = conn.execute("SELECT COUNT(*) FROM wc2026_matches WHERE score_ft_home IS NOT NULL").fetchone()[0]
    future = total - scored
    r = conn.execute("SELECT MIN(match_date), MAX(match_date) FROM wc2026_matches").fetchone()
    print(f"  Total matches: {total}")
    print(f"  Played (with scores): {scored}")
    print(f"  Future (NULL scores): {future}")
    print(f"  Date range: {r[0]} -> {r[1]}")
    # Teams
    teams_c = conn.execute("SELECT COUNT(DISTINCT team1)+COUNT(DISTINCT team2) FROM wc2026_matches").fetchone()[0]  # approx
    print(f"  Distinct teams involved: ~{teams_c}")

    # wc2026_teams
    section("DEEP ANALYSIS: wc2026_teams")
    total = conn.execute("SELECT COUNT(*) FROM wc2026_teams").fetchone()[0]
    print(f"  Total teams: {total}")
    confs = conn.execute("SELECT confederation, COUNT(*) as n FROM wc2026_teams GROUP BY confederation ORDER BY n DESC").fetchall()
    for c in confs:
        print(f"    {c['confederation']:10s}: {c['n']}")
    # Data completeness
    for col in ['fifa_rank','fifa_points','total_market_value_eur','average_age']:
        c = conn.execute(f"SELECT COUNT(*) FROM wc2026_teams WHERE {col} IS NOT NULL AND {col} > 0").fetchone()[0]
        print(f"    {col:25s}: {c}/{total}")

    # international_results
    section("DEEP ANALYSIS: international_results")
    total = conn.execute("SELECT COUNT(*) FROM international_results").fetchone()[0]
    scored = conn.execute("SELECT COUNT(*) FROM international_results WHERE home_score IS NOT NULL").fetchone()[0]
    r = conn.execute("SELECT MIN(date), MAX(date) FROM international_results").fetchone()
    print(f"  Total rows: {fmt_count(total)}")
    print(f"  With scores: {fmt_count(scored)} ({scored/total*100:.1f}%)")
    print(f"  Date range: {r[0]} -> {r[1]}")
    # Tournaments
    tots = conn.execute("SELECT tournament, COUNT(*) as n FROM international_results GROUP BY tournament ORDER BY n DESC LIMIT 30").fetchall()
    print(f"\n  Top {len(tots)} tournaments:")
    for t in tots:
        print(f"    {t['tournament']:40s}: {fmt_count(t['n']):>8s}")
    # Per year
    print("\n  Matches per year (2015+):")
    for r in conn.execute("SELECT strftime('%Y', date) as yr, COUNT(*) as n FROM international_results WHERE date >= '2015-01-01' AND home_score IS NOT NULL GROUP BY yr ORDER BY yr DESC").fetchall():
        print(f"    {r['yr']}: {fmt_count(r['n'])}")
    # Teams
    teams = conn.execute("SELECT COUNT(DISTINCT home_team)+COUNT(DISTINCT away_team) FROM international_results").fetchone()[0]
    print(f"\n  Distinct teams: ~{teams}")

    # soccer tables
    section("DEEP ANALYSIS: soccer-dataset tables")
    for tname in ['soccer_fixtures','soccer_match_stats','soccer_odds','soccer_teams','soccer_leagues']:
        total = conn.execute(f"SELECT COUNT(*) FROM \"{tname}\"").fetchone()[0]
        print(f"\n  [{tname}] {fmt_count(total)} rows")
        if tname == 'soccer_fixtures':
            scored = conn.execute("SELECT COUNT(*) FROM soccer_fixtures WHERE goals_home IS NOT NULL AND status='FT'").fetchone()[0]
            r = conn.execute("SELECT MIN(date), MAX(date) FROM soccer_fixtures").fetchone()
            print(f"    FT with scores: {fmt_count(scored)}")
            print(f"    Date range: {r[0]} -> {r[1]}")
        elif tname == 'soccer_match_stats':
            with_xg = conn.execute("SELECT COUNT(*) FROM soccer_match_stats WHERE home_xg IS NOT NULL").fetchone()[0]
            print(f"    With home_xg: {fmt_count(with_xg)}")
        elif tname == 'soccer_odds':
            books = conn.execute("SELECT bookmaker, COUNT(*) as n FROM soccer_odds GROUP BY bookmaker ORDER BY n DESC").fetchall()
            print(f"    Bookmakers:")
            for b in books:
                print(f"      {b['bookmaker']:30s}: {fmt_count(b['n'])}")
        elif tname == 'soccer_teams':
            fd_mapped = conn.execute("SELECT COUNT(*) FROM soccer_teams WHERE fd_name IS NOT NULL AND fd_name != ''").fetchone()[0]
            print(f"    With fd_name mapping: {fmt_count(fd_mapped)}")
        elif tname == 'soccer_leagues':
            countries = conn.execute("SELECT country, COUNT(*) as n FROM soccer_leagues GROUP BY country ORDER BY n DESC LIMIT 15").fetchall()
            print(f"    Top countries (leagues):")
            for c in countries:
                print(f"      {c['country']:20s}: {c['n']}")

    # Soccer-dataset league depths for top-5 + others
    subsection("Soccer-dataset: Top Leagues by Match Volume")
    leagues = conn.execute("""
        SELECT l.name, l.country, COUNT(*) as n
        FROM soccer_fixtures f
        JOIN soccer_leagues l ON f.league_id = l.id
        WHERE f.goals_home IS NOT NULL AND f.status='FT'
        GROUP BY l.name ORDER BY n DESC LIMIT 30
    """).fetchall()
    for l in leagues:
        print(f"    {l['name']:35s} ({l['country']:15s}): {fmt_count(l['n']):>8s}")

    # Soccer-dataset year distribution
    print("\n  Soccer-dataset matches per year:")
    for r in conn.execute("""
        SELECT strftime('%Y', date) as yr, COUNT(*) as n
        FROM soccer_fixtures WHERE goals_home IS NOT NULL AND status='FT'
        GROUP BY yr ORDER BY yr DESC LIMIT 15
    """).fetchall():
        print(f"    {r['yr']}: {fmt_count(r['n'])}")

    # Fotmob leagues
    section("DEEP ANALYSIS: fotmob_leagues")
    total = conn.execute("SELECT COUNT(*) FROM fotmob_leagues").fetchone()[0]
    print(f"  Total leagues: {total}")
    # Countries
    cntrs = conn.execute("SELECT country, COUNT(*) as n FROM fotmob_leagues GROUP BY country ORDER BY n DESC LIMIT 20").fetchall()
    print("  Top countries:")
    for c in cntrs:
        print(f"    {c['country']:20s}: {c['n']}")

    # archive_matches
    section("DEEP ANALYSIS: archive_matches")
    total = conn.execute("SELECT COUNT(*) FROM archive_matches").fetchone()[0]
    with_stats = conn.execute("SELECT COUNT(*) FROM archive_matches WHERE stats_blob IS NOT NULL AND stats_blob != '[]'").fetchone()[0]
    r = conn.execute("SELECT MIN(match_date), MAX(match_date) FROM archive_matches").fetchone()
    print(f"  Total: {fmt_count(total)}")
    print(f"  With stats: {fmt_count(with_stats)}")
    print(f"  Date range: {r[0]} -> {r[1]}")

    conn.close()


# ──────────────────────────────────────────────────────────────
# 2. CODEBASE FEATURE DISCOVERY
# ──────────────────────────────────────────────────────────────

def extract_feature_names(filepath, label):
    subsection(f"FEATURES: {label} ({os.path.basename(filepath)})")
    if not os.path.exists(filepath):
        print(f"  [NOT FOUND]")
        return []
    with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()
    
    # Find FEATURE_NAMES_* lists
    features = {}
    for match in re.finditer(r'(FEATURE_NAMES_\w+)\s*=\s*\[(.*?)\]', content, re.DOTALL):
        name = match.group(1)
        items = re.findall(r"'([^']+)'", match.group(2))
        features[name] = items
        print(f"  {name}: {len(items)} features")
        # Print first 10
        print(f"    First 10: {items[:10]}")
        # Print last 3
        print(f"    Last 3:   {items[-3:]}")
    
    # Find feature_volatility
    vol_match = re.search(r'FEATURE_VOLATILITY\s*=\s*\[(.*?)\]', content, re.DOTALL)
    if vol_match:
        vols = re.findall(r"[\d.]+", vol_match.group(1))
        print(f"\n  FEATURE_VOLATILITY: {len(vols)} values")
    
    # Count total unique features across all lists
    all_feats = set()
    for name, items in features.items():
        all_feats.update(items)
    print(f"\n  Total unique features across all lists: {len(all_feats)}")

    return features

def analyze_prediction_chain(filepath):
    subsection("MODEL FALLBACK CHAIN (prediction_engine.py)")
    if not os.path.exists(filepath):
        print("  [NOT FOUND]")
        return
    with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()
    
    # Find all MODEL_PATH definitions
    paths = re.findall(r"(\w+_MODEL_PATH)\s*=\s*['\"]([^'\"]+)['\"]", content)
    print("  Model paths defined:")
    for var, path in paths:
        exists = "EXISTS" if os.path.exists(os.path.join(BASE_DIR, path)) else "MISSING"
        print(f"    {var:30s} -> {path:45s} [{exists}]")
    
    # Find get_*_booster functions
    boosters = re.findall(r'def (get_\w+_booster)\(', content)
    print(f"\n  Booster loader functions: {len(boosters)}")
    for b in boosters:
        print(f"    - {b}()")
    
    # Find fallback chain
    fallback = re.findall(r'(V\d{3})', content)
    unique = sorted(set(fallback), key=lambda x: int(x[1:]) if x[1:].isdigit() else 0, reverse=True)
    print(f"\n  Model versions referenced: {unique}")

def analyze_ml_features_pipeline(filepath):
    subsection("ML FEATURES PIPELINE (ml_features.py)")
    if not os.path.exists(filepath):
        print("  [NOT FOUND]")
        return
    with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()
    
    # Count extract_ml_features lines
    lines = content.split('\n')
    print(f"  Total lines: {len(lines)}")
    
    # Find feature extraction blocks
    key_funcs = re.findall(r'def (\w+)\(', content)
    print(f"  Key functions:")
    for func in ['extract_ml_features','get_wc2026_team_data','get_team_history',
                  '_get_decayed_avg','_get_dual_stat']:
        if f'def {func}(' in content:
            # Find line number
            for i, line in enumerate(lines):
                if f'def {func}(' in line:
                    print(f"    {func:40s} line {i+1}")
                    break
    
    # Find all feature name references in extract_ml_features
    feat_assigns = re.findall(r"features\['([^']+)'\]", content)
    print(f"\n  feature dict keys assigned: {len(set(feat_assigns))}")
    # Categorize
    categories = {}
    for f in set(feat_assigns):
        prefix = f.split('_')[0] if '_' in f else f
        categories.setdefault(prefix, []).append(f)
    print("  Top categories:")
    for cat in sorted(categories, key=lambda k: -len(categories[k]))[:15]:
        print(f"    h_{cat:15s}: {len(categories[cat])} features ({categories[cat][:3]})")

def analyze_model_files():
    section("MODEL FILES")
    if not os.path.exists(MODELS_DIR):
        print("[SKIP] No models directory")
        return
    files = glob.glob(os.path.join(MODELS_DIR, '*.json'))
    print(f"\n  Total model files: {len(files)}")
    for f in sorted(files):
        size_kb = os.path.getsize(f) / 1024
        fname = os.path.basename(f)
        # Read model metadata (first few bytes)
        try:
            with open(f, 'r', encoding='utf-8', errors='replace') as mf:
                first = mf.read(500)
            learner = re.search(r'"learner".*?"feature_names":\s*\[(.*?)\]', first, re.DOTALL)
            nfeats = len(re.findall(r'"', first[:200]))  # rough
            pass
        except:
            nfeat = '?'
        print(f"  {fname:45s} {size_kb:8.1f} KB")

def analyze_data_files():
    section("DATA FILES")
    if not os.path.exists(DATA_DIR):
        print("[SKIP] No data directory")
        return
    files = glob.glob(os.path.join(DATA_DIR, '*'))
    print(f"\n  Files ({len(files)}):")
    for f in sorted(files):
        size_mb = os.path.getsize(f) / (1024*1024) if os.path.isfile(f) else 0
        fname = os.path.basename(f)
        ftype = "DIR" if os.path.isdir(f) else "FILE"
        print(f"  [{ftype}] {fname:45s} {size_mb:8.2f} MB" if os.path.isfile(f) else f"  [{ftype}] {fname}")

def analyze_core_services():
    section("CORE & SERVICES OVERVIEW")
    for dname, label in [(CORE_DIR, 'Core'), (SERVICES_DIR, 'Services')]:
        if not os.path.exists(dname):
            continue
        pyfiles = sorted(glob.glob(os.path.join(dname, '*.py')) + glob.glob(os.path.join(dname, '*.js')))
        print(f"\n  [{label}] {len(pyfiles)} files:")
        for f in pyfiles:
            lines = sum(1 for _ in open(f, 'r', encoding='utf-8', errors='replace'))
            print(f"    {os.path.basename(f):40s} {lines:6d} lines")

# ──────────────────────────────────────────────────────────────
# 3. EXECUTION
# ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"\n{'#' * 80}")
    print(f"  HamdiProno / Stitch --- Full Database & Codebase Discovery")
    print(f"  System Architecture Audit --- June 2026")
    print(f"{'#' * 80}\n")
    print(f"  Workspace: {BASE_DIR}")
    print(f"  Archive DB: {os.path.exists(DB_ARCHIVE)} ({os.path.getsize(DB_ARCHIVE)/(1024*1024):.1f} MB)" if os.path.exists(DB_ARCHIVE) else "  Archive DB: NOT FOUND")
    print(f"  Tactical DB: {os.path.exists(DB_TACTICAL)}")

    explore_db(DB_ARCHIVE, "historical_archive.sqlite")
    explore_db(DB_TACTICAL, "tactical.db")
    explore_archive()

    extract_feature_names(os.path.join(CORE_DIR, 'ml_features.py'), "ML Features")
    analyze_prediction_chain(os.path.join(CORE_DIR, 'prediction_engine.py'))
    analyze_ml_features_pipeline(os.path.join(CORE_DIR, 'ml_features.py'))
    analyze_model_files()
    analyze_data_files()
    analyze_core_services()

    # Summary stats
    section("SUMMARY METRICS")
    conn = sqlite3.connect(DB_ARCHIVE)
    total_matches = (
        conn.execute("SELECT COUNT(*) FROM archive_football_data").fetchone()[0] +
        conn.execute("SELECT COUNT(*) FROM archive_matches").fetchone()[0] +
        conn.execute("SELECT COUNT(*) FROM wc2026_matches").fetchone()[0] +
        conn.execute("SELECT COUNT(*) FROM international_results WHERE home_score IS NOT NULL").fetchone()[0] +
        conn.execute("SELECT COUNT(*) FROM soccer_fixtures WHERE goals_home IS NOT NULL AND status='FT'").fetchone()[0]
    )
    print(f"\n  Total training-ready matches across all tables: {fmt_count(total_matches)}")
    print(f"  Distinct models: {len(glob.glob(os.path.join(MODELS_DIR, '*.json')))}")
    conn.close()

    print(f"\n{'#' * 80}")
    print(f"  Discovery complete.")
    print(f"{'#' * 80}\n")
