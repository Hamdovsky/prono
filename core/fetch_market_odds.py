"""
fetch_market_odds.py — Collecte des cotes Corners/HT (audit C) depuis football-data.co.uk.

Source GRATUITE (CSV public, sans API payante). Remplit les colonnes
odds_corner_over/under, corner_line, odds_ht_over/under, ht_line dans
archive_football_data pour activer le ROI Corners/HT dans accuracyEngine.

Usage :
  python -m core.fetch_market_odds --url https://www.football-data.co.uk/mm/mmz2025.csv
  python -m core.fetch_market_odds --csv chemin/local.csv

Le matching se fait sur (match_date, home_team, away_team). Les noms de colonnes
football-data varient selon les saisons ; on utilise un regex best-effort et on
prend le premier bookmaker disponible (priorite B365 > PS > LB > WH > VC).
"""
import argparse
import csv
import io
import os
import re
import sqlite3
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ARCHIVE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "historical_archive.sqlite")

BOOKMAKERS = ["B365", "PS", "LB", "WH", "VC", "SO"]
CORNER_OVER_RE = re.compile(r"^(?:B365|PS|LB|WH|VC|SO)C>(\d+(?:\.\d+)?)$", re.I)
CORNER_UNDER_RE = re.compile(r"^(?:B365|PS|LB|WH|VC|SO)C<(\d+(?:\.\d+)?)$", re.I)
HT_OVER_RE = re.compile(r"^(?:B365|PS|LB|WH|VC|SO)CH>(\d+(?:\.\d+)?)$", re.I)
HT_UNDER_RE = re.compile(r"^(?:B365|PS|LB|WH|VC|SO)CH<(\d+(?:\.\d+)?)$", re.I)

COLS = [
    ("odds_corner_over", "REAL"),
    ("odds_corner_under", "REAL"),
    ("corner_line", "REAL"),
    ("odds_ht_over", "REAL"),
    ("odds_ht_under", "REAL"),
    ("ht_line", "REAL"),
]


def ensure_schema(con):
    cur = con.execute("PRAGMA table_info(archive_football_data)")
    existing = {r[1] for r in cur.fetchall()}
    for name, typ in COLS:
        if name not in existing:
            con.execute(f"ALTER TABLE archive_football_data ADD COLUMN {name} {typ}")
    con.commit()


def normalize_team(s):
    if s is None:
        return ""
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def parse_fd_date(s):
    # football-data.co.uk : DD/MM/YY ou YYYY-MM-DD
    if s is None:
        return None
    s = s.strip()
    for fmt in ("%d/%m/%y", "%d/%m/%Y", "%Y-%m-%d"):
        try:
            import datetime
            return datetime.datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _find_pair(row, over_re, under_re):
    # Retourne (over_val, under_val, line) depuis le meme bookmaker si possible.
    for bm in BOOKMAKERS:
        prefix = bm.upper()
        for k, v in row.items():
            if k is None or v in (None, ""):
                continue
            mo = over_re.match(k)
            if mo and k[: len(prefix)].upper() == prefix:
                line = mo.group(1)
                under_key = k.replace(">", "<")
                uv = row.get(under_key)
                if uv not in (None, ""):
                    try:
                        return float(v), float(uv), float(line)
                    except (TypeError, ValueError):
                        continue
    # fallback : n'importe quel bookmaker avec les deux cotes
    for k, v in row.items():
        if k is None or v in (None, ""):
            continue
        mo = over_re.match(k)
        if mo:
            uk = k.replace(">", "<")
            uv = row.get(uk)
            if uv not in (None, ""):
                try:
                    return float(v), float(uv), float(mo.group(1))
                except (TypeError, ValueError):
                    continue
    return None


def extract_odds(row):
    out = {}
    corner = _find_pair(row, CORNER_OVER_RE, CORNER_UNDER_RE)
    if corner:
        out["odds_corner_over"], out["odds_corner_under"], out["corner_line"] = corner
    ht = _find_pair(row, HT_OVER_RE, HT_UNDER_RE)
    if ht:
        out["odds_ht_over"], out["odds_ht_under"], out["ht_line"] = ht
    return out or None


def upsert(con, rows):
    updated = 0
    for date_iso, home, away, odds in rows:
        if not (date_iso and home and away):
            continue
        cand = con.execute(
            "SELECT id, home_team, away_team FROM archive_football_data WHERE match_date=?",
            (date_iso,),
        ).fetchall()
        for rid, db_home, db_away in cand:
            if normalize_team(db_home) == home and normalize_team(db_away) == away:
                con.execute(
                    "UPDATE archive_football_data SET "
                    "odds_corner_over=COALESCE(?, odds_corner_over), "
                    "odds_corner_under=COALESCE(?, odds_corner_under), "
                    "corner_line=COALESCE(?, corner_line), "
                    "odds_ht_over=COALESCE(?, odds_ht_over), "
                    "odds_ht_under=COALESCE(?, odds_ht_under), "
                    "ht_line=COALESCE(?, ht_line) "
                    "WHERE id=?",
                    (
                        odds.get("odds_corner_over"),
                        odds.get("odds_corner_under"),
                        odds.get("corner_line"),
                        odds.get("odds_ht_over"),
                        odds.get("odds_ht_under"),
                        odds.get("ht_line"),
                        rid,
                    ),
                )
                updated += 1
    con.commit()
    return updated


def process_csv(text, con):
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    matched = 0
    for row in reader:
        date_iso = parse_fd_date(row.get("Date") or row.get("date"))
        home = normalize_team(row.get("HomeTeam") or row.get("home_team") or row.get("Home"))
        away = normalize_team(row.get("AwayTeam") or row.get("away_team") or row.get("Away"))
        odds = extract_odds(row)
        if odds:
            rows.append((date_iso, home, away, odds))
    updated = upsert(con, rows)
    return len(rows), updated


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url")
    ap.add_argument("--csv")
    args = ap.parse_args()
    if not os.path.exists(ARCHIVE):
        print(f"[fetch_market_odds] archive introuvable : {ARCHIVE}")
        return
    con = sqlite3.connect(ARCHIVE)
    ensure_schema(con)
    if args.csv:
        with open(args.csv, encoding="utf-8", errors="replace") as f:
            text = f.read()
    elif args.url:
        with urllib.request.urlopen(args.url, timeout=30) as resp:
            text = resp.read().decode("utf-8", "replace")
    else:
        print("[fetch_market_odds] fournir --url ou --csv")
        return
    n_rows, updated = process_csv(text, con)
    print(f"[fetch_market_odds] lignes avec cotes Corners/HT = {n_rows}, MAJ archive = {updated}")
    con.close()


if __name__ == "__main__":
    main()
