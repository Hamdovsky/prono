#!/usr/bin/env python3
"""
Import all World Cup 2026 data into historical_archive.sqlite.

Data sources:
  1) risingtransfers world-cup-2026-data (squads.csv, per90_stats.csv)
  2) transfermarkt-datasets.duckdb (players, national_teams)
  3) openfootball worldcup.json (104 matches)
  4) Hardcoded FIFA rankings (June 2026)
"""

import csv
import json
import os
import sqlite3
import sys

# ---------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------
BASE = r"C:\Users\HAMDI\Desktop\HamdiProno\stitch"
DB_PATH = os.path.join(BASE, "data", "historical_archive.sqlite")
TEMP = r"C:\Users\HAMDI\AppData\Local\Temp\opencode\worldcup.json"

SQUADS_CSV = os.path.join(TEMP, "world-cup-2026-data", "data", "squads.csv")
PER90_CSV = os.path.join(TEMP, "world-cup-2026-data", "data", "per90_stats.csv")
TM_DUCKDB = os.path.join(TEMP, "transfermarkt-datasets.duckdb")
OF_JSON = os.path.join(TEMP, "2026", "worldcup.json")

# ---------------------------------------------------------------------------
# hardcoded data
# ---------------------------------------------------------------------------

FIFA_RANKINGS = [
    ("Argentina", 1, 1877.27), ("Spain", 2, 1874.71), ("France", 3, 1870.70),
    ("England", 4, 1828.02), ("Portugal", 5, 1767.85), ("Brazil", 6, 1765.86),
    ("Morocco", 7, 1755.10), ("Netherlands", 8, 1753.57), ("Belgium", 9, 1742.24),
    ("Germany", 10, 1735.77), ("Croatia", 11, 1714.87), ("Italy", 12, 1704.73),
    ("Colombia", 13, 1698.35), ("Mexico", 14, 1687.48), ("Senegal", 15, 1684.07),
    ("Uruguay", 16, 1673.07), ("USA", 17, 1671.23), ("Japan", 18, 1661.58),
    ("Switzerland", 19, 1650.06), ("IR Iran", 20, 1619.58), ("Denmark", 21, 1619.47),
    ("Turkiye", 22, 1605.73), ("Ecuador", 23, 1598.52), ("Austria", 24, 1597.40),
    ("Korea Republic", 25, 1591.63), ("Nigeria", 26, 1585.02), ("Australia", 27, 1579.34),
    ("Algeria", 28, 1571.03), ("Egypt", 29, 1562.37), ("Canada", 30, 1559.48),
    ("Norway", 31, 1557.44), ("Ukraine", 32, 1549.29), ("Cote d'Ivoire", 33, 1540.87),
    ("Panama", 34, 1539.16), ("Russia", 35, 1529.60), ("Poland", 36, 1526.18),
    ("Wales", 37, 1516.95), ("Sweden", 38, 1509.79), ("Hungary", 39, 1506.39),
    ("Czechia", 40, 1505.74), ("Paraguay", 41, 1505.35), ("Scotland", 42, 1503.34),
    ("Serbia", 43, 1502.13), ("Cameroon", 44, 1481.24), ("Tunisia", 45, 1476.41),
    ("Congo DR", 46, 1474.43), ("Slovakia", 47, 1473.66), ("Greece", 48, 1473.19),
    ("Venezuela", 49, 1469.18), ("Uzbekistan", 50, 1458.73), ("Chile", 51, 1458.20),
    ("Peru", 52, 1457.69), ("Costa Rica", 53, 1456.03), ("Romania", 54, 1455.89),
    ("Mali", 55, 1455.59), ("Qatar", 56, 1450.31), ("Iraq", 57, 1446.28),
    ("Ireland", 58, 1441.10), ("Slovenia", 59, 1441.09), ("South Africa", 60, 1428.38),
    ("Saudi Arabia", 61, 1423.88), ("Burkina Faso", 62, 1406.99), ("Jordan", 63, 1387.74),
    ("Bosnia and Herzegovina", 64, 1387.22), ("Honduras", 65, 1378.97), ("Albania", 66, 1376.03),
    ("Cabo Verde", 67, 1371.11), ("UAE", 68, 1370.47), ("North Macedonia", 69, 1369.16),
    ("Northern Ireland", 70, 1365.30), ("Jamaica", 71, 1357.84), ("Georgia", 72, 1355.26),
    ("Ghana", 73, 1346.88), ("Iceland", 74, 1342.77), ("Finland", 75, 1341.92),
    ("Israel", 76, 1333.90), ("Bolivia", 77, 1326.00), ("Kosovo", 78, 1319.12),
    ("Oman", 79, 1306.90), ("Montenegro", 80, 1301.98), ("Guinea", 81, 1295.60),
    ("Curacao", 82, 1294.77), ("Haiti", 83, 1293.10), ("Syria", 84, 1283.05),
    ("New Zealand", 85, 1275.58), ("Gabon", 86, 1272.51), ("Bulgaria", 87, 1271.68),
    ("Angola", 88, 1265.58), ("Uganda", 89, 1264.09), ("Zambia", 90, 1255.82),
    ("China PR", 91, 1254.81), ("Bahrain", 92, 1254.41), ("Benin", 93, 1252.17),
    ("Thailand", 94, 1250.80), ("Palestine", 95, 1243.71), ("Belarus", 96, 1242.88),
    ("Guatemala", 97, 1238.74), ("Luxembourg", 98, 1232.82), ("Vietnam", 99, 1225.68),
    ("El Salvador", 100, 1225.34),
]

WC2026_TEAMS = {
    "Argentina": "CONMEBOL", "Spain": "UEFA", "France": "UEFA", "England": "UEFA",
    "Portugal": "UEFA", "Brazil": "CONMEBOL", "Morocco": "CAF", "Netherlands": "UEFA",
    "Belgium": "UEFA", "Germany": "UEFA", "Croatia": "UEFA", "Colombia": "CONMEBOL",
    "Mexico": "CONCACAF", "Senegal": "CAF", "Uruguay": "CONMEBOL", "USA": "CONCACAF",
    "Japan": "AFC", "Switzerland": "UEFA", "IR Iran": "AFC", "Turkiye": "UEFA",
    "Ecuador": "CONMEBOL", "Austria": "UEFA", "Korea Republic": "AFC", "Australia": "AFC",
    "Algeria": "CAF", "Egypt": "CAF", "Canada": "CONCACAF", "Norway": "UEFA",
    "Cote d'Ivoire": "CAF", "Panama": "CONCACAF", "Sweden": "UEFA", "Paraguay": "CONMEBOL",
    "Scotland": "UEFA", "Uzbekistan": "AFC", "Qatar": "AFC", "South Africa": "CAF",
    "Saudi Arabia": "AFC", "Jordan": "AFC", "Bosnia and Herzegovina": "UEFA",
    "Cabo Verde": "CAF", "Ghana": "CAF", "Iraq": "AFC", "Tunisia": "CAF",
    "Congo DR": "CAF", "Czechia": "UEFA", "Haiti": "CONCACAF", "Curacao": "CONCACAF",
    "New Zealand": "OFC",
}

# Map openfootball match team names to our canonical names
TEAM_NAME_MAP = {
    "South Korea": "Korea Republic",
    "Iran": "IR Iran",
    "Turkey": "Turkiye",
    "Ivory Coast": "Cote d'Ivoire",
    "Cape Verde": "Cabo Verde",
    "Curaçao": "Curacao",
    "DR Congo": "Congo DR",
    "Czech Republic": "Czechia",
    "Bosnia & Herzegovina": "Bosnia and Herzegovina",
    "USA": "USA",
}

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


def ensure_dir(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)


def open_sqlite():
    return sqlite3.connect(DB_PATH)


def init_tables(conn):
    """Drop and recreate all wc2026_* tables."""
    cur = conn.cursor()
    cur.execute("DROP TABLE IF EXISTS wc2026_teams")
    cur.execute("DROP TABLE IF EXISTS wc2026_squads")
    cur.execute("DROP TABLE IF EXISTS wc2026_matches")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS wc2026_teams (
            team_name TEXT PRIMARY KEY,
            confederation TEXT,
            fifa_rank INTEGER,
            fifa_points REAL,
            total_market_value_eur REAL,
            squad_size INTEGER,
            average_age REAL,
            coach_name TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS wc2026_squads (
            player_id INTEGER,
            player_name TEXT,
            country TEXT,
            position TEXT,
            club TEXT,
            age REAL,
            market_value_eur REAL,
            per90_minutes INTEGER,
            per90_goals REAL,
            per90_assists REAL,
            per90_shots REAL,
            per90_key_passes REAL,
            per90_tackles REAL,
            per90_rating REAL,
            tm_market_value_eur REAL,
            tm_position TEXT,
            tm_highest_value_eur REAL
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS wc2026_matches (
            round TEXT,
            match_date TEXT,
            time TEXT,
            team1 TEXT,
            team2 TEXT,
            score_ht_home INTEGER,
            score_ht_away INTEGER,
            score_ft_home INTEGER,
            score_ft_away INTEGER,
            group_name TEXT,
            ground TEXT,
            PRIMARY KEY (round, team1, team2)
        )
    """)

    conn.commit()
    eprint("Tables wc2026_teams, wc2026_squads, wc2026_matches ready.")


# ---------------------------------------------------------------------------
# 1. Load FIFA rankings + WC2026 teams into wc2026_teams
# ---------------------------------------------------------------------------

def load_fifa_rankings(conn):
    """Insert hardcoded FIFA rankings, overlaid with WC2026 confederation and
    transfermarkt data (if available)."""
    cur = conn.cursor()
    rank_map = {name: (rk, pts) for name, rk, pts in FIFA_RANKINGS}

    for team, conf in WC2026_TEAMS.items():
        rank, points = rank_map.get(team, (None, None))
        cur.execute(
            """INSERT OR REPLACE INTO wc2026_teams
               (team_name, confederation, fifa_rank, fifa_points)
               VALUES (?, ?, ?, ?)""",
            (team, conf, rank, points),
        )

    conn.commit()
    eprint(f"Loaded {len(WC2026_TEAMS)} teams with FIFA rankings.")


# ---------------------------------------------------------------------------
# 2. Enrich wc2026_teams with transfermarkt national_teams data
# ---------------------------------------------------------------------------

def enrich_teams_from_transfermarkt(conn):
    """Merge total_market_value, squad_size, average_age, coach_name from
    transfermarkt DuckDB into wc2026_teams."""

    # Reverse mapping: openfootball / canonical → transfermarkt name
    tm_name_map = {
        "Korea Republic": "South Korea",
        "IR Iran": "Iran",
        "Turkiye": "Turkey",
        "Cote d'Ivoire": "Ivory Coast",
        "Cabo Verde": "Cape Verde",
        "Curacao": "Curaçao",
        "Congo DR": "DR Congo",
        "Czechia": "Czech Republic",
        "Bosnia and Herzegovina": "Bosnia & Herzegovina",
    }

    try:
        import duckdb
    except ImportError:
        eprint("duckdb not installed – skip transfermarkt enrichment.")
        return

    if not os.path.isfile(TM_DUCKDB):
        eprint(f"transfermarkt DuckDB not found at {TM_DUCKDB} – skipping.")
        return

    tm_con = duckdb.connect(TM_DUCKDB)
    try:
        rows = tm_con.execute(
            "SELECT name, total_market_value, squad_size, average_age, coach_name "
            "FROM national_teams"
        ).fetchall()
    except Exception as exc:
        eprint(f"Error reading national_teams: {exc}")
        tm_con.close()
        return
    tm_con.close()

    cur = conn.cursor()
    updated = 0
    for tm_name, mv, squad, age, coach in rows:
        canonical = tm_name_map.get(tm_name, tm_name)
        if canonical not in WC2026_TEAMS:
            continue
        cur.execute(
            """UPDATE wc2026_teams SET
               total_market_value_eur = COALESCE(?, total_market_value_eur),
               squad_size           = COALESCE(?, squad_size),
               average_age          = COALESCE(?, average_age),
               coach_name           = COALESCE(?, coach_name)
               WHERE team_name = ?""",
            (mv, squad, age, coach, canonical),
        )
        if cur.rowcount:
            updated += 1

    conn.commit()
    eprint(f"Enriched {updated} teams from transfermarkt.")


# ---------------------------------------------------------------------------
# 3. Load squads + per90 stats + transfermarkt market values
# ---------------------------------------------------------------------------

def _build_tm_player_map():
    """Return dict {lowercase_name: (market_value, highest_value, position)}
    from transfermarkt DuckDB players table."""
    try:
        import duckdb
    except ImportError:
        return {}

    if not os.path.isfile(TM_DUCKDB):
        return {}

    tm_con = duckdb.connect(TM_DUCKDB)
    try:
        rows = tm_con.execute(
            "SELECT name, market_value_in_eur, highest_market_value_in_eur, position "
            "FROM players WHERE market_value_in_eur IS NOT NULL"
        ).fetchall()
    except Exception as exc:
        eprint(f"Error reading players: {exc}")
        tm_con.close()
        return {}
    tm_con.close()

    pmap = {}
    for name, mv, hmv, pos in rows:
        key = name.strip().lower()
        pmap[key] = (mv, hmv, pos)
    return pmap


def load_squads(conn):
    """Read squads.csv, join per90_stats.csv by player_id, look up transfermarkt
    values, and insert into wc2026_squads."""
    if not os.path.isfile(SQUADS_CSV):
        eprint(f"squads.csv not found at {SQUADS_CSV} – aborting squads import.")
        return

    # read per90 stats into dict keyed by player_id → row
    per90 = {}
    if os.path.isfile(PER90_CSV):
        with open(PER90_CSV, encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                pid = int(row["player_id"])
                per90[pid] = row
        eprint(f"Loaded {len(per90)} per90 stat records.")
    else:
        eprint(f"per90_stats.csv not found – proceeding without per90 stats.")

    # build transfermarkt player map
    tm_map = _build_tm_player_map()
    eprint(f"Built transfermarkt map with {len(tm_map)} players.")

    cur = conn.cursor()
    inserted = 0
    skipped = 0

    with open(SQUADS_CSV, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            pid = int(row["player_id"])
            pname = row["player_name"]
            country = row["country"]
            position = row["position"]
            club = row["club"]
            age = _float_or_none(row["age"])
            mv_eur = _float_or_none(row["rt_value_estimate_eur"])

            # per90 lookup
            p90 = per90.get(pid)
            p90_min = _int_or_none(p90["minutes"]) if p90 else None
            p90_gls = _float_or_none(p90["goals_per90"]) if p90 else None
            p90_ast = _float_or_none(p90["assists_per90"]) if p90 else None
            p90_sho = _float_or_none(p90["shots_per90"]) if p90 else None
            p90_kp = _float_or_none(p90["key_passes_per90"]) if p90 else None
            p90_tck = _float_or_none(p90["tackles_per90"]) if p90 else None
            p90_rat = _float_or_none(p90["rating"]) if p90 else None

            # transfermarkt lookup by normalized name
            tm_key = pname.strip().lower()
            tm_hit = tm_map.get(tm_key)
            tm_mv = tm_hit[0] if tm_hit else None
            tm_hv = tm_hit[1] if tm_hit else None
            tm_pos = tm_hit[2] if tm_hit else None

            try:
                cur.execute(
                    """INSERT INTO wc2026_squads
                       (player_id, player_name, country, position, club, age,
                        market_value_eur,
                        per90_minutes, per90_goals, per90_assists, per90_shots,
                        per90_key_passes, per90_tackles, per90_rating,
                        tm_market_value_eur, tm_position, tm_highest_value_eur)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (pid, pname, country, position, club, age, mv_eur,
                     p90_min, p90_gls, p90_ast, p90_sho, p90_kp, p90_tck, p90_rat,
                     tm_mv, tm_pos, tm_hv),
                )
                inserted += 1
            except Exception as exc:
                eprint(f"  Error inserting player {pid} {pname}: {exc}")
                skipped += 1

    conn.commit()
    eprint(f"Squads: inserted {inserted}, skipped {skipped}.")


# ---------------------------------------------------------------------------
# 4. Load matches from openfootball worldcup.json
# ---------------------------------------------------------------------------

def load_matches(conn):
    """Parse worldcup.json and insert into wc2026_matches."""
    if not os.path.isfile(OF_JSON):
        eprint(f"worldcup.json not found at {OF_JSON} – aborting matches import.")
        return

    with open(OF_JSON, encoding="utf-8") as f:
        data = json.load(f)

    matches = data.get("matches", [])
    cur = conn.cursor()
    inserted = 0
    skipped = 0

    for m in matches:
        rnd = m.get("round", "")
        date = m.get("date", "")
        tm = m.get("time", "")
        t1 = m.get("team1", "")
        t2 = m.get("team2", "")
        grp = m.get("group", "")
        ground = m.get("ground", "")

        # Skip placeholder knockout teams (Wnn, Lnnn)
        if t1.startswith(("W", "L")) and len(t1) > 2 and t1[1:].isdigit():
            skipped += 1
            continue
        if t2.startswith(("W", "L")) and len(t2) > 2 and t2[1:].isdigit():
            skipped += 1
            continue
        # Skip group stage placeholders like "1A", "2B", "3A/B/C/D/F"
        if t1[0].isdigit() or t2[0].isdigit():
            skipped += 1
            continue

        # Normalize team names
        t1 = TEAM_NAME_MAP.get(t1, t1)
        t2 = TEAM_NAME_MAP.get(t2, t2)

        score = m.get("score")
        if score:
            ft = score.get("ft", [None, None])
            ht = score.get("ht", [None, None])
            sh, sa = (ft[0], ft[1]) if len(ft) == 2 else (None, None)
            hth, hta = (ht[0], ht[1]) if len(ht) == 2 else (None, None)
        else:
            sh = sa = hth = hta = None

        try:
            cur.execute(
                """INSERT OR REPLACE INTO wc2026_matches
                   (round, match_date, time, team1, team2,
                    score_ht_home, score_ht_away,
                    score_ft_home, score_ft_away,
                    group_name, ground)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (rnd, date, tm, t1, t2, hth, hta, sh, sa, grp, ground),
            )
            inserted += 1
        except Exception as exc:
            eprint(f"  Error inserting match {rnd} {t1}-{t2}: {exc}")
            skipped += 1

    conn.commit()
    eprint(f"Matches: inserted {inserted}, skipped {skipped} (placeholders).")


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _float_or_none(val):
    if val is None:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _int_or_none(val):
    if val is None:
        return None
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    ensure_dir(DB_PATH)
    conn = open_sqlite()
    conn.execute("PRAGMA journal_mode=WAL")

    init_tables(conn)

    eprint("\n--- Step 1: FIFA rankings + team list ---")
    load_fifa_rankings(conn)

    eprint("\n--- Step 2: Transfermarkt team enrichment ---")
    enrich_teams_from_transfermarkt(conn)

    eprint("\n--- Step 3: Squads + per90 + transfermarkt values ---")
    load_squads(conn)

    eprint("\n--- Step 4: Matches ---")
    load_matches(conn)

    # Summary
    cur = conn.cursor()
    for table in ("wc2026_teams", "wc2026_squads", "wc2026_matches"):
        cnt = cur.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        eprint(f"  {table}: {cnt} rows")

    conn.close()
    eprint("\nDone. All WC 2026 data imported successfully.")


if __name__ == "__main__":
    main()
