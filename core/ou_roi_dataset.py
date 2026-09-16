"""
ou_roi_dataset.py — Dataset PROPRE de cotes O/U 2.5 (E38).

Source de verite : tactical.db (space Node).
  - historical_matches.fullData -> odds_over25/under25 + xG FotMob (home_xg/away_xg)
  - matches.odds_over25/under25 + home_xg/away_xg (rangees scorees)

L'archive historical_archive.sqlite a bien des colonnes odds_over/odds_under MAIS
il s'agit d'un Handicap Asiatique (lignes negatives), PAS du market total buts :
on n'en tient JAMAIS compte pour le ROI O/U.

Sortie : rangees pour core.roi_markets.walkforward_ou_roi, dedoublonnees par
(date, home, away). Lecture seule.
"""
import datetime
import json
import os
import sqlite3

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TACTICAL = os.path.join(REPO, "data", "tactical.db")
LINE = 2.5


def _norm_date(raw):
    if not raw:
        return ""
    s = str(raw).strip()
    if s[:4].isdigit() and len(s) >= 10 and s[:10].count("-") == 2:
        return s[:10]
    if s.isdigit():
        try:
            return datetime.datetime.utcfromtimestamp(int(s) / 1000.0).strftime("%Y-%m-%d")
        except (ValueError, OSError):
            return ""
    return ""


def _fd(row):
    try:
        return json.loads(row["fullData"] or "{}")
    except (TypeError, ValueError):
        return {}


def load_clean_ou_rows():
    """Rangees [(date, home, away, league, total_xg, line, goals, odds_over,
    odds_under)] pour le walk-forward ROI O/U 2.5. Vide si base absente."""
    if not os.path.exists(TACTICAL):
        return []
    con = sqlite3.connect(TACTICAL)
    con.row_factory = sqlite3.Row
    out = {}
    try:
        for r in con.execute(
            "SELECT timestamp, homeTeam, awayTeam, league, scoreHome, scoreAway, fullData "
            "FROM historical_matches WHERE scoreHome IS NOT NULL"
        ):
            fd = _fd(r)
            if not (fd.get("odds_over25") and fd.get("odds_under25")):
                continue
            if fd.get("home_xg") is None or fd.get("away_xg") is None:
                continue
            key = (_norm_date(r["timestamp"]), r["homeTeam"] or "", r["awayTeam"] or "")
            out[key] = {
                "date": key[0],
                "league": r["league"] or "?",
                "total_xg": float(fd["home_xg"]) + float(fd["away_xg"]),
                "line": LINE,
                "goals": int((r["scoreHome"] or 0)) + int((r["scoreAway"] or 0)),
                "odds_over": float(fd["odds_over25"]),
                "odds_under": float(fd["odds_under25"]),
            }
        for r in con.execute(
            "SELECT timestamp, homeTeam, awayTeam, league, scoreHome, scoreAway, "
            "home_xg, away_xg, odds_over25, odds_under25 FROM matches "
            "WHERE scoreHome IS NOT NULL AND odds_over25 IS NOT NULL "
            "AND odds_under25 IS NOT NULL AND home_xg IS NOT NULL AND away_xg IS NOT NULL"
        ):
            key = (_norm_date(r["timestamp"]), r["homeTeam"] or "", r["awayTeam"] or "")
            if key in out:
                continue
            out[key] = {
                "date": key[0],
                "league": r["league"] or "?",
                "total_xg": float(r["home_xg"]) + float(r["away_xg"]),
                "line": LINE,
                "goals": int((r["scoreHome"] or 0)) + int((r["scoreAway"] or 0)),
                "odds_over": float(r["odds_over25"]),
                "odds_under": float(r["odds_under25"]),
            }
    finally:
        con.close()
    return list(out.values())