"""
backfill_ht_corners_from_csv.py
Backfill HT score + corners into historical_matches from football-data.co.uk CSV.

Source: data_pipeline/data/raw/football_data_all.csv (5301 rows, 5300 with HT + corners)
Target: data/tactical.db -> historical_matches.ht_score_home/away, corners_home/away

Matching strategy:
  1. Load teamAliases.js (existing) + add football_data specific aliases
  2. Normalize: lowercase, strip "City"/"FC"/"United"/etc., apply alias map
  3. Join on (normalized_home, normalized_away, date) — date tolerance ±1 day
  4. COALESCE: don't overwrite existing values

Usage:
  python scripts/backfill_ht_corners_from_csv.py           # dry run (default)
  python scripts/backfill_ht_corners_from_csv.py --apply
"""
import argparse
import csv
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "config"))

try:
    from teamAliases import TEAM_ALIAS_MAP  # noqa: E402
except ImportError:
    TEAM_ALIAS_MAP = {}

CSV_PATHS = [
    os.path.join(ROOT, "data_pipeline", "data", "raw", "football_data_all.csv"),
    os.path.join(ROOT, "data_pipeline", "data", "raw", "football_data_fixtures.csv"),
]
DB_PATHS = [
    os.path.join(ROOT, "data", "tactical.db"),
    os.path.join(ROOT, "data", "predictions.db"),
]

# Columns to ensure exist on historical_matches (idempotent migration)
HM_COLUMNS = [
    ("ht_score_home", "INTEGER"),
    ("ht_score_away", "INTEGER"),
    ("corners_home", "INTEGER"),
    ("corners_away", "INTEGER"),
    ("corners_ht_home", "INTEGER"),
    ("corners_ht_away", "INTEGER"),
]

# Aliases specific to football-data.co.uk (their abbreviations)
FD_ALIASES = {
    "Coventry": "Coventry City",
    "Nott'm Forest": "Nottingham Forest",
    "Sheff Utd": "Sheffield United",
    "Sheff Wed": "Sheffield Wednesday",
    "West Brom": "West Bromwich Albion",
    "Man United": "Manchester United",
    "Man City": "Manchester City",
    "Tottenham": "Tottenham Hotspur",
    "Leicester": "Leicester City",
    "Wolves": "Wolverhampton Wanderers",
    "Brighton": "Brighton & Hove Albion",
    "Newcastle": "Newcastle United",
    "West Ham": "West Ham United",
    "Norwich": "Norwich City",
    "Leeds": "Leeds United",
    "Luton": "Luton Town",
    "Bournemouth": "AFC Bournemouth",
    "Bayern Munich": "Bayern München",
    "Dortmund": "Borussia Dortmund",
    "Leverkusen": "Bayer Leverkusen",
    "Gladbach": "Borussia Mönchengladbach",
    "M'gladbach": "Borussia Mönchengladbach",
    "Ath Madrid": "Atletico Madrid",
    "Ath Bilbao": "Athletic Club",
    "Real Sociedad": "Real Sociedad",
    "Celta": "Celta Vigo",
    "Vallecano": "Rayo Vallecano",
    "Alaves": "Alavés",
    "Verona": "Hellas Verona",
    "Roma": "AS Roma",
    "Atalanta": "Atalanta BC",
}

ALL_ALIASES = {**TEAM_ALIAS_MAP, **FD_ALIASES}

_STRIP_RE = re.compile(r"\b(city|fc|cf|united|utd|athletic|atletico|wanderers|albion|rovers|town|the)\b", re.IGNORECASE)
_NONALPHA_RE = re.compile(r"[^a-z0-9]")


def normalize(name):
    """Lowercase, strip accents, apply aliases, remove punctuation."""
    if not name:
        return ""
    n = name.strip()
    n = ALL_ALIASES.get(n, n)  # exact alias first
    n = _STRIP_RE.sub(" ", n)
    n = n.lower()
    # remove accents
    import unicodedata
    n = "".join(c for c in unicodedata.normalize("NFKD", n) if not unicodedata.combining(c))
    n = _NONALPHA_RE.sub("", n)
    return n


def _open_db():
    for p in DB_PATHS:
        if os.path.exists(p):
            db = sqlite3.connect(p)
            _ensure_columns(db)
            return db
    raise FileNotFoundError("no DB found in data/")


def _ensure_columns(db):
    """Idempotent: add HT + corners columns to historical_matches if missing."""
    cur = db.cursor()
    cur.execute('PRAGMA table_info(historical_matches)')
    existing = {r[1] for r in cur.fetchall()}
    for col, typedef in HM_COLUMNS:
        if col not in existing:
            try:
                cur.execute(f"ALTER TABLE historical_matches ADD COLUMN {col} {typedef}")
                print(f"  + historical_matches.{col} {typedef}")
            except Exception as e:
                print(f"  ! could not add {col}: {e}")
    db.commit()


def _to_int(s):
    try:
        v = int(float(s))
        return v if v >= 0 else None
    except (TypeError, ValueError):
        return None


def build_csv_index(csv_path):
    """Build (normalized_home, normalized_away, date) -> {hthg, htag, hc, ac}."""
    idx = {}
    with open(csv_path, encoding="utf-8", errors="ignore") as f:
        reader = csv.DictReader(f)
        for row in reader:
            h = normalize(row.get("home_team", ""))
            a = normalize(row.get("away_team", ""))
            d = row.get("date", "")  # YYYY-MM-DD
            if not h or not a or not d:
                continue
            key = (h, a, d)
            idx[key] = {
                "hthg": _to_int(row.get("hthg")),
                "htag": _to_int(row.get("htag")),
                "hc": _to_int(row.get("hc")),
                "ac": _to_int(row.get("ac")),
            }
    return idx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Write to DB (default: dry run)")
    ap.add_argument("--limit", type=int, default=10000, help="Max historical_matches to scan")
    ap.add_argument("--date-tolerance", type=int, default=1, help="± days for date match")
    args = ap.parse_args()

    csv_path = next((p for p in CSV_PATHS if os.path.exists(p)), None)
    if not csv_path:
        print("ERROR: no football_data CSV found")
        return

    print(f"[INFO] CSV: {csv_path}")
    csv_idx = build_csv_index(csv_path)
    print(f"[INFO] CSV rows indexed: {len(csv_idx)}")

    db = _open_db()
    cur = db.cursor()

    # Find candidates: historical_matches without ht_score_home OR without corners_home
    cur.execute(
        """
        SELECT id, homeTeam, awayTeam, timestamp, ht_score_home, corners_home
          FROM historical_matches
         WHERE (ht_score_home IS NULL OR corners_home IS NULL)
         ORDER BY timestamp DESC
         LIMIT ?
        """,
        (args.limit,),
    )
    rows = cur.fetchall()
    print(f"[INFO] historical_matches to scan: {len(rows)}")

    n_matched = 0
    n_ht_written = 0
    n_c_written = 0
    samples = []

    for row in rows:
        mid, h, a, ts, existing_ht, existing_c = row
        h_n = normalize(h)
        a_n = normalize(a)
        if not h_n or not a_n:
            continue
        # Extract date from timestamp (ms or ISO)
        date_str = None
        try:
            if ts and isinstance(ts, str) and "T" in ts:
                date_str = ts[:10]
            elif ts and isinstance(ts, (int, float)) and ts > 1e12:
                import datetime
                date_str = datetime.datetime.utcfromtimestamp(ts / 1000).strftime("%Y-%m-%d")
        except Exception:
            pass
        if not date_str:
            continue

        # Try exact date, then ±tolerance
        hit = None
        from datetime import datetime, timedelta
        try:
            d = datetime.strptime(date_str, "%Y-%m-%d")
        except ValueError:
            continue
        for delta in range(0, args.date_tolerance + 1):
            for sign in [0, 1, -1] if delta else [0]:
                d_try = (d + timedelta(days=sign * delta)).strftime("%Y-%m-%d")
                hit = csv_idx.get((h_n, a_n, d_try))
                if hit:
                    break
            if hit:
                break

        if not hit:
            continue
        n_matched += 1
        updates = []
        params = []
        if existing_ht is None and hit["hthg"] is not None and hit["htag"] is not None:
            updates.append("ht_score_home = ?")
            params.append(hit["hthg"])
            updates.append("ht_score_away = ?")
            params.append(hit["htag"])
            n_ht_written += 1
        if existing_c is None and hit["hc"] is not None and hit["ac"] is not None:
            updates.append("corners_home = ?")
            params.append(hit["hc"])
            updates.append("corners_away = ?")
            params.append(hit["ac"])
            n_c_written += 1
        if updates:
            params.append(mid)
            sql = f"UPDATE historical_matches SET {', '.join(updates)} WHERE id = ?"
            if args.apply:
                cur.execute(sql, params)
            elif len(samples) < 8:
                samples.append((mid, h, a, date_str, hit))

    if args.apply:
        db.commit()
    db.close()

    mode = "APPLIED" if args.apply else "DRY-RUN"
    print(f"\n=== [{mode}] Matched: {n_matched}/{len(rows)}  HT written: {n_ht_written}  Corners written: {n_c_written} ===")
    if samples:
        print("\nSamples:")
        for mid, h, a, d, hit in samples:
            print(f"  id={mid}  {h!r} vs {a!r}  date={d}  HT={hit['hthg']}-{hit['htag']}  corners={hit['hc']}-{hit['ac']}")


if __name__ == "__main__":
    main()
