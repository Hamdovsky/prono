#!/usr/bin/env python3
"""
Import enhanced datasets into historical_archive.sqlite.

Sources:
  1) martj42/international_results — 49K+ international matches (1872-2026)
  2) eatpizzanot/soccer-dataset — 378K fixtures, 258K match stats, 220K odds (2012-2026)
"""

import csv
import os
import sqlite3
import sys
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE, "data", "historical_archive.sqlite")
RAW_DIR = os.path.join(BASE, "data", "raw")
SOCCER_CSV_DIR = r"C:\Users\HAMDI\AppData\Local\Temp\opencode\worldcup.json\soccer-dataset\csv"

MARTJ42_URL = "https://raw.githubusercontent.com/martj42/international_results/master/results.csv"
MARTJ42_CSV = os.path.join(RAW_DIR, "international_results.csv")


def ensure_dir(d):
    os.makedirs(d, exist_ok=True)


def download_martj42():
    if os.path.exists(MARTJ42_CSV):
        sz = os.path.getsize(MARTJ42_CSV)
        print(f"  martj42 already downloaded ({sz//1024} KB)")
        return
    print("  Downloading martj42/international_results (49K matches)...")
    ensure_dir(RAW_DIR)
    urllib.request.urlretrieve(MARTJ42_URL, MARTJ42_CSV)
    print(f"  Done ({os.path.getsize(MARTJ42_CSV)//1024} KB)")


def import_martj42(conn):
    print("\n=== Importing martj42/international_results ===")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS international_results (
            date TEXT,
            home_team TEXT,
            away_team TEXT,
            home_score INTEGER,
            away_score INTEGER,
            tournament TEXT,
            city TEXT,
            country TEXT,
            neutral INTEGER DEFAULT 0
        )
    """)
    existing = conn.execute("SELECT COUNT(*) FROM international_results").fetchone()[0]
    if existing > 0:
        print(f"  Table already has {existing} rows — dropping and re-importing")
        conn.execute("DROP TABLE international_results")
        conn.execute("""
            CREATE TABLE international_results (
                date TEXT,
                home_team TEXT,
                away_team TEXT,
                home_score INTEGER,
                away_score INTEGER,
                tournament TEXT,
                city TEXT,
                country TEXT,
                neutral INTEGER DEFAULT 0
            )
        """)

    count = 0
    with open(MARTJ42_CSV, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = []
        for row in reader:
            rows.append((
                row["date"],
                row["home_team"],
                row["away_team"],
                int(row["home_score"]) if row.get("home_score") and row["home_score"].strip().isdigit() else None,
                int(row["away_score"]) if row.get("away_score") and row["away_score"].strip().isdigit() else None,
                row["tournament"],
                row.get("city", ""),
                row.get("country", ""),
                1 if row.get("neutral", "").upper() == "TRUE" else 0,
            ))
            count += 1
            if count % 10000 == 0:
                conn.executemany(
                    "INSERT INTO international_results VALUES (?,?,?,?,?,?,?,?,?)", rows
                )
                conn.commit()
                rows = []
                print(f"    ... {count} rows")
        if rows:
            conn.executemany(
                "INSERT INTO international_results VALUES (?,?,?,?,?,?,?,?,?)", rows
            )
            conn.commit()
    print(f"  Imported {count} international matches")


def import_soccer_dataset(conn):
    print("\n=== Importing eatpizzanot/soccer-dataset ===")

    if not os.path.exists(SOCCER_CSV_DIR):
        print(f"  WARN: soccer-dataset not found at {SOCCER_CSV_DIR}, skipping")
        return

    # --- Teams ---
    print("  Importing teams...")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS soccer_teams (
            id INTEGER PRIMARY KEY,
            name TEXT,
            api_football_id TEXT,
            fd_name TEXT
        )
    """)
    existing = conn.execute("SELECT COUNT(*) FROM soccer_teams").fetchone()[0]
    if existing == 0:
        with open(os.path.join(SOCCER_CSV_DIR, "teams.csv"), encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = [(int(r["id"]), r["name"], r.get("api_football_id", ""), r.get("fd_name", "")) for r in reader]
            conn.executemany("INSERT OR IGNORE INTO soccer_teams VALUES (?,?,?,?)", rows)
            conn.commit()
        print(f"    {len(rows)} teams")
    else:
        print(f"    Already has {existing} teams")

    # --- Leagues ---
    print("  Importing leagues...")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS soccer_leagues (
            id INTEGER PRIMARY KEY,
            name TEXT,
            country TEXT,
            fd_code TEXT
        )
    """)
    existing = conn.execute("SELECT COUNT(*) FROM soccer_leagues").fetchone()[0]
    if existing == 0:
        with open(os.path.join(SOCCER_CSV_DIR, "leagues.csv"), encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = [(int(r["id"]), r["name"], r.get("country", ""), r.get("fd_code", "")) for r in reader]
            conn.executemany("INSERT OR IGNORE INTO soccer_leagues VALUES (?,?,?,?)", rows)
            conn.commit()
        print(f"    {len(rows)} leagues")
    else:
        print(f"    Already has {existing} leagues")

    # --- Fixtures ---
    print("  Importing fixtures...")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS soccer_fixtures (
            id INTEGER PRIMARY KEY,
            date TEXT,
            league_id INTEGER,
            home_team_id INTEGER,
            away_team_id INTEGER,
            goals_home INTEGER,
            goals_away INTEGER,
            status TEXT,
            referee_name TEXT
        )
    """)
    existing = conn.execute("SELECT COUNT(*) FROM soccer_fixtures").fetchone()[0]
    if existing == 0:
        count = 0
        with open(os.path.join(SOCCER_CSV_DIR, "fixtures.csv"), encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = []
            for row in reader:
                rows.append((
                    int(row["id"]),
                    row["date"][:10],
                    int(row["league_id"]),
                    int(row["home_team_id"]),
                    int(row["away_team_id"]),
                    int(row["goals_home"]) if row.get("goals_home") else None,
                    int(row["goals_away"]) if row.get("goals_away") else None,
                    row["status"],
                    row.get("referee_name", ""),
                ))
                count += 1
                if count % 50000 == 0:
                    conn.executemany(
                        "INSERT OR IGNORE INTO soccer_fixtures VALUES (?,?,?,?,?,?,?,?,?)", rows
                    )
                    conn.commit()
                    rows = []
                    print(f"    ... {count} fixtures")
            if rows:
                conn.executemany(
                    "INSERT OR IGNORE INTO soccer_fixtures VALUES (?,?,?,?,?,?,?,?,?)", rows
                )
                conn.commit()
        print(f"    Imported {count} fixtures")
    else:
        print(f"    Already has {existing} fixtures")

    # --- Match Stats ---
    print("  Importing match stats...")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS soccer_match_stats (
            id INTEGER PRIMARY KEY,
            fixture_id INTEGER,
            home_shots_total INTEGER, away_shots_total INTEGER,
            home_shots_on_goal INTEGER, away_shots_on_goal INTEGER,
            home_shots_inside_box INTEGER, away_shots_inside_box INTEGER,
            home_xg REAL, away_xg REAL,
            home_corners INTEGER, away_corners INTEGER,
            home_yellow_cards INTEGER, away_yellow_cards INTEGER,
            home_red_cards INTEGER, away_red_cards INTEGER,
            home_possession INTEGER, away_possession INTEGER,
            home_fouls INTEGER, away_fouls INTEGER
        )
    """)
    existing = conn.execute("SELECT COUNT(*) FROM soccer_match_stats").fetchone()[0]
    if existing == 0:
        count = 0
        with open(os.path.join(SOCCER_CSV_DIR, "match_stats.csv"), encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = []
            for row in reader:
                rows.append((
                    int(row["id"]),
                    int(row["fixture_id"]),
                    int(row["home_shots_total"]) if row.get("home_shots_total") else None,
                    int(row["away_shots_total"]) if row.get("away_shots_total") else None,
                    int(row["home_shots_on_goal"]) if row.get("home_shots_on_goal") else None,
                    int(row["away_shots_on_goal"]) if row.get("away_shots_on_goal") else None,
                    int(row["home_shots_inside_box"]) if row.get("home_shots_inside_box") else None,
                    int(row["away_shots_inside_box"]) if row.get("away_shots_inside_box") else None,
                    float(row["home_xg"]) if row.get("home_xg") else None,
                    float(row["away_xg"]) if row.get("away_xg") else None,
                    int(row["home_corners"]) if row.get("home_corners") else None,
                    int(row["away_corners"]) if row.get("away_corners") else None,
                    int(row["home_yellow_cards"]) if row.get("home_yellow_cards") else None,
                    int(row["away_yellow_cards"]) if row.get("away_yellow_cards") else None,
                    int(row["home_red_cards"]) if row.get("home_red_cards") else None,
                    int(row["away_red_cards"]) if row.get("away_red_cards") else None,
                    int(row["home_possession"]) if row.get("home_possession") else None,
                    int(row["away_possession"]) if row.get("away_possession") else None,
                    int(row["home_fouls"]) if row.get("home_fouls") else None,
                    int(row["away_fouls"]) if row.get("away_fouls") else None,
                ))
                count += 1
                if count % 50000 == 0:
                    conn.executemany(
                        "INSERT OR IGNORE INTO soccer_match_stats VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows
                    )
                    conn.commit()
                    rows = []
                    print(f"    ... {count} stats")
            if rows:
                conn.executemany(
                    "INSERT OR IGNORE INTO soccer_match_stats VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows
                )
                conn.commit()
        print(f"    Imported {count} match stats")
    else:
        print(f"    Already has {existing} match stats")

    # --- Odds ---
    print("  Importing odds...")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS soccer_odds (
            id INTEGER PRIMARY KEY,
            fixture_id INTEGER,
            home_win REAL,
            draw REAL,
            away_win REAL,
            bookmaker TEXT,
            source TEXT
        )
    """)
    existing = conn.execute("SELECT COUNT(*) FROM soccer_odds").fetchone()[0]
    if existing == 0:
        count = 0
        with open(os.path.join(SOCCER_CSV_DIR, "odds.csv"), encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = []
            for row in reader:
                rows.append((
                    int(row["id"]),
                    int(row["fixture_id"]),
                    float(row["home_win"]) if row.get("home_win") else None,
                    float(row["draw"]) if row.get("draw") else None,
                    float(row["away_win"]) if row.get("away_win") else None,
                    row.get("bookmaker", ""),
                    row.get("source", ""),
                ))
                count += 1
                if count % 50000 == 0:
                    conn.executemany(
                        "INSERT OR IGNORE INTO soccer_odds VALUES (?,?,?,?,?,?,?)", rows
                    )
                    conn.commit()
                    rows = []
                    print(f"    ... {count} odds")
            if rows:
                conn.executemany(
                    "INSERT OR IGNORE INTO soccer_odds VALUES (?,?,?,?,?,?,?)", rows
                )
                conn.commit()
                conn.commit()
        print(f"    Imported {count} odds records")
    else:
        print(f"    Already has {existing} odds records")


def main():
    print("=" * 60)
    print("Importing enhanced datasets into historical_archive.sqlite")
    print("=" * 60)

    download_martj42()

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=OFF")

    import_martj42(conn)
    import_soccer_dataset(conn)

    conn.close()
    print("\nDone!")


if __name__ == "__main__":
    main()
