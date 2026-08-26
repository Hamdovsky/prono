"""
Tests du fetch des cotes Corners/HT (audit C) : parsing + upsert, sans reseau.
"""
import io
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.fetch_market_odds import (
    extract_odds,
    parse_fd_date,
    normalize_team,
    ensure_schema,
    process_csv,
    BOOKMAKERS,
)

CSV = """Date,HomeTeam,AwayTeam,B365C>9.5,B365C<9.5,B365CH>0.5,B365CH<0.5,PS>2.5,PS<2.5
12/08/23,Arsenal,Leicester,1.90,1.90,2.10,1.70,1.80,2.00
"""


def _make_db():
    con = sqlite3.connect(":memory:")
    con.execute(
        "CREATE TABLE archive_football_data ("
        "id INTEGER PRIMARY KEY, match_date TEXT, home_team TEXT, away_team TEXT)"
    )
    con.execute(
        "INSERT INTO archive_football_data (match_date, home_team, away_team) "
        "VALUES ('2023-08-12', 'Arsenal', 'Leicester')"
    )
    ensure_schema(con)
    return con


def test_parse_fd_date():
    assert parse_fd_date("12/08/23") == "2023-08-12"
    assert parse_fd_date("2023-08-12") == "2023-08-12"
    assert parse_fd_date("nope") is None


def test_normalize_team():
    assert normalize_team("Arsenal") == "arsenal"
    assert normalize_team("Bright & Hove Alb.") == "brighthovealb"


def test_extract_odds():
    row = {
        "B365C>9.5": "1.90",
        "B365C<9.5": "1.90",
        "B365CH>0.5": "2.10",
        "B365CH<0.5": "1.70",
    }
    o = extract_odds(row)
    assert o["odds_corner_over"] == 1.9
    assert o["odds_corner_under"] == 1.9
    assert o["corner_line"] == 9.5
    assert o["odds_ht_over"] == 2.1
    assert o["odds_ht_under"] == 1.7
    assert o["ht_line"] == 0.5


def test_extract_odds_empty():
    assert extract_odds({"B365H": "2.0"}) is None


def test_extract_odds_broadened_formats():
    # bookmakers etendus (PIN, BET)
    row = {
        "PINC>9.5": "1.85",
        "PINC<9.5": "1.95",
        "BETCH>0.5": "2.05",
        "BETCH<0.5": "1.75",
    }
    o = extract_odds(row)
    assert o["odds_corner_over"] == 1.85
    assert o["corner_line"] == 9.5
    assert o["odds_ht_over"] == 2.05
    assert o["ht_line"] == 0.5


def test_extract_odds_direct_columns():
    row = {
        "odds_corner_over": "1.9",
        "odds_corner_under": "1.9",
        "corner_line": "9.5",
        "odds_ht_over": "2.1",
        "odds_ht_under": "1.7",
        "ht_line": "0.5",
    }
    o = extract_odds(row)
    assert o["odds_corner_over"] == 1.9 and o["odds_ht_under"] == 1.7


def test_ensure_schema_idempotent():
    con = sqlite3.connect(":memory:")
    con.execute("CREATE TABLE archive_football_data (id INTEGER)")
    ensure_schema(con)
    ensure_schema(con)  # ne doit pas planter
    cols = {r[1] for r in con.execute("PRAGMA table_info(archive_football_data)")}
    assert "odds_corner_over" in cols
    assert "odds_ht_under" in cols


def test_process_csv_upserts_matching_row():
    con = _make_db()
    n_rows, updated = process_csv(CSV, con)
    assert n_rows == 1
    assert updated == 1
    row = con.execute(
        "SELECT odds_corner_over, odds_corner_under, corner_line, odds_ht_over, "
        "odds_ht_under, ht_line FROM archive_football_data"
    ).fetchone()
    assert row[0] == 1.9 and row[2] == 9.5 and row[3] == 2.1 and row[5] == 0.5


def test_priority_bookmaker():
    row = {"PSCH>0.5": "3.0", "PSCH<0.5": "1.3", "B365CH>0.5": "2.1", "B365CH<0.5": "1.7"}
    o = extract_odds(row)
    # B365 a la priorite sur PS
    assert o["odds_ht_over"] == 2.1
