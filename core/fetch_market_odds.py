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

BOOKMAKERS = ["B365", "PS", "LB", "WH", "VC", "SO", "PIN", "MAX", "BET", "UNI", "MAR"]
# Formats acceptes : B365C>9.5 / B365C<9.5 (Corners), B365CH>0.5 / B365CH<0.5 (HT).
# Separateurs > et < ; prefixes de marche C (corners) et CH (HT).
_CORNER_RE = r"^(?:B365|PS|LB|WH|VC|SO|PIN|MAX|BET|UNI|MAR)\s*C>(\d+(?:\.\d+)?)$"
_CORNER_UNDER_RE = r"^(?:B365|PS|LB|WH|VC|SO|PIN|MAX|BET|UNI|MAR)\s*C<(\d+(?:\.\d+)?)$"
_HT_RE = r"^(?:B365|PS|LB|WH|VC|SO|PIN|MAX|BET|UNI|MAR)\s*CH>(\d+(?:\.\d+)?)$"
_HT_UNDER_RE = r"^(?:B365|PS|LB|WH|VC|SO|PIN|MAX|BET|UNI|MAR)\s*CH<(\d+(?:\.\d+)?)$"
CORNER_OVER_RE = re.compile(_CORNER_RE, re.I)
CORNER_UNDER_RE = re.compile(_CORNER_UNDER_RE, re.I)
HT_OVER_RE = re.compile(_HT_RE, re.I)
HT_UNDER_RE = re.compile(_HT_UNDER_RE, re.I)
# Nom de colonnes directs (si le CSV utilise deja nos noms)
DIRECT_MAP = {
    "odds_corner_over": "odds_corner_over",
    "odds_corner_under": "odds_corner_under",
    "corner_line": "corner_line",
    "odds_ht_over": "odds_ht_over",
    "odds_ht_under": "odds_ht_under",
    "ht_line": "ht_line",
}

COLS = [
    ("odds_corner_over", "REAL"),
    ("odds_corner_under", "REAL"),
    ("corner_line", "REAL"),
    ("odds_ht_over", "REAL"),
    ("odds_ht_under", "REAL"),
    ("ht_line", "REAL"),
]

RESULTS_COLS = [
    ("hthg", "INTEGER"),
    ("htag", "INTEGER"),
    ("hc", "INTEGER"),
    ("ac", "INTEGER"),
    ("hs", "INTEGER"),
    ("as", "INTEGER"),
    ("hy", "INTEGER"),
    ("ay", "INTEGER"),
    ("hr", "INTEGER"),
    ("ar", "INTEGER"),
]


def ensure_schema(con):
    cur = con.execute("PRAGMA table_info(archive_football_data)")
    existing = {r[1] for r in cur.fetchall()}
    for name, typ in COLS + RESULTS_COLS:
        if name not in existing:
            con.execute(f"ALTER TABLE archive_football_data ADD COLUMN \"{name}\" {typ}")
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
    # 1) colonnes directes (si le CSV utilise deja nos noms)
    direct = {dst: _to_float(row.get(src)) for src, dst in DIRECT_MAP.items()}
    direct = {k: v for k, v in direct.items() if v is not None}
    if direct:
        # ligne/bookmaker par defaut si absent
        direct.setdefault("corner_line", 9.5)
        direct.setdefault("ht_line", 0.5)
        return direct
    # 2) sinon parsing par bookmaker (B365C>9.5, B365CH>0.5, ...)
    corner = _find_pair(row, CORNER_OVER_RE, CORNER_UNDER_RE)
    if corner:
        out["odds_corner_over"], out["odds_corner_under"], out["corner_line"] = corner
    ht = _find_pair(row, HT_OVER_RE, HT_UNDER_RE)
    if ht:
        out["odds_ht_over"], out["odds_ht_under"], out["ht_line"] = ht
    return out or None


def extract_results(row):
    """Extrait les scores HT et stats réelle (corners, shots, cartes) depuis le CSV."""
    out = {}
    for csv_key, col_name in [
        ("HTHG", "hthg"), ("HTAG", "htag"),
        ("HC", "hc"), ("AC", "ac"),
        ("HS", "hs"), ("AS", "as"),
        ("HY", "hy"), ("AY", "ay"),
        ("HR", "hr"), ("AR", "ar"),
    ]:
        val = _to_int(row.get(csv_key))
        if val is not None:
            out[col_name] = val
    return out if out else None


def _to_int(v):
    try:
        if v is None or v == "":
            return None
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _to_float(v):
    try:
        if v is None or v == "":
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def upsert(con, rows):
    updated = 0
    for date_iso, home, away, odds, results in rows:
        if not (date_iso and home and away):
            continue
        cand = con.execute(
            "SELECT id, home_team, away_team FROM archive_football_data WHERE match_date=?",
            (date_iso,),
        ).fetchall()
        for rid, db_home, db_away in cand:
            if normalize_team(db_home) == home and normalize_team(db_away) == away:
                sets = []
                vals = []
                for col in ["odds_corner_over","odds_corner_under","corner_line",
                             "odds_ht_over","odds_ht_under","ht_line"]:
                    if odds.get(col) is not None:
                        sets.append(f"{col}=COALESCE(?,{col})")
                        vals.append(odds.get(col))
                for col in ["hthg","htag","hc","ac","hs","as","hy","ay","hr","ar"]:
                    if results and results.get(col) is not None:
                        sets.append(f"{col}=COALESCE(?,{col})")
                        vals.append(results.get(col))
                if not sets:
                    continue
                vals.append(rid)
                con.execute(f"UPDATE archive_football_data SET {','.join(sets)} WHERE id=?", vals)
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
        results = extract_results(row)
        if odds or results:
            rows.append((date_iso, home, away, odds or {}, results or {}))
    updated = upsert(con, rows)
    return len(rows), updated


def print_template():
    print(
        "Date,HomeTeam,AwayTeam,B365C>9.5,B365C<9.5,B365CH>0.5,B365CH<0.5\n"
        "12/08/23,Arsenal,Leicester,1.90,1.90,2.10,1.70\n"
        "# Format accepte (football-data.co.uk ou equivalent) :\n"
        "#  - Date : DD/MM/YY ou YYYY-MM-DD\n"
        "#  - HomeTeam / AwayTeam : noms exacts de l'archive\n"
        "#  - cotes Corners : <BOOK>C>ligne et <BOOK>C<ligne  (B365, PS, LB, WH, VC, PIN, MAX, BET...)\n"
        "#  - cotes HT       : <BOOK>CH>0.5 et <BOOK>CH<0.5\n"
        "#  - ou nommes directement odds_corner_over, odds_corner_under, corner_line,\n"
        "#    odds_ht_over, odds_ht_under, ht_line\n"
        "# Puis : python -m core.fetch_market_odds --csv monfichier.csv"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url")
    ap.add_argument("--csv")
    ap.add_argument("--dry-run", action="store_true", help="affiche le nb de lignes sans ecrire")
    ap.add_argument("--template", action="store_true", help="affiche un CSV d'exemple")
    args = ap.parse_args()
    if args.template:
        print_template()
        return
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
        print("[fetch_market_odds] fournir --url, --csv ou --template")
        return
    if args.dry_run:
        reader = csv.DictReader(io.StringIO(text))
        n = sum(1 for row in reader if extract_odds(row))
        print(f"[fetch_market_odds][dry-run] lignes avec cotes Corners/HT = {n} (aucune ecriture)")
        con.close()
        return
    n_rows, updated = process_csv(text, con)
    print(f"[fetch_market_odds] lignes avec cotes Corners/HT = {n_rows}, MAJ archive = {updated}")
    con.close()


if __name__ == "__main__":
    main()
