"""
backfillFootballData.py — Backfill d'historique de cotes via football-data.co.uk (CSV gratuits).

Source 100% gratuite, sans clé API : https://www.football-data.co.uk/data.php
SoccerData (<FootballData>) télécharge et normalise ces CSV (cotes B365, Pinnacle, etc.).

IMPORTANT: cet historique est utilise UNIQUEMENT pour l'entrainement / le backtest
(valuation de modeles, calibration). Il n'est PAS injecte dans le scoring live
(qui utilise les cotes live BetExplorer via oddsFusionEngine tier1b).

Usage:
  python scripts/backfillFootballData.py [--seasons 2425 2324] [--leagues ENG ESP]
  python scripts/backfillFootballData.py --all
"""

import os
import sys
import argparse
import logging
import warnings
import sqlite3

logging.disable(logging.CRITICAL)
warnings.filterwarnings("ignore")

import pandas as pd
import requests

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "historical_archive.sqlite")

# football-data.co.uk : codes ligue -> fichier CSV
LEAGUE_MAP = {
    "ENG": "E0",
    "ESP": "SP1",
    "GER": "D1",
    "ITA": "I1",
    "FRA": "F1",
}

ALL_SEASONS = ["2425", "2324", "2223", "2122", "2021"]
ALL_LEAGUES = list(LEAGUE_MAP.keys())


def get_conn():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS fd_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT,
            league TEXT,
            home_team TEXT,
            away_team TEXT,
            home_goals INTEGER,
            away_goals INTEGER,
            b365h REAL, b365d REAL, b365a REAL,
            psh REAL, psd REAL, psa REAL,
            avgh REAL, avgd REAL, avga REAL,
            over25 REAL, under25 REAL,
            btts_yes REAL, btts_no REAL,
            UNIQUE(league, date, home_team, away_team)
        )
        """
    )
    return conn


def safe(v):
    try:
        if v is None or (isinstance(v, float) and (v != v)):
            return None
        fv = float(v)
        return fv if fv > 0 else None
    except (TypeError, ValueError):
        return None


def backfill(seasons, leagues):
    league_files = {l: LEAGUE_MAP[l] for l in leagues if l in LEAGUE_MAP}
    print(f"[BACKFILL] leagues={list(league_files.values())} seasons={seasons}")
    conn = get_conn()
    total = 0

    for season in seasons:
        for lkey, lfile in league_files.items():
            url = f"https://www.football-data.co.uk/mmz4281/{season}/{lfile}.csv"
            try:
                r = requests.get(url, timeout=30)
                if r.status_code != 200:
                    print(f"[BACKFILL] skip {url} ({r.status_code})")
                    continue
                df = pd.read_csv(url if url.startswith("http") else pd.io.common.StringIO(r.text))
            except Exception as e:
                print(f"[BACKFILL] download error {url}: {e}")
                continue

            cols = set(df.columns)
            for _, row in df.iterrows():
                date = str(row.get("Date") or "")[:10]
                home = str(row.get("HomeTeam") or "")
                away = str(row.get("AwayTeam") or "")
                if not home or not away or date in ("", "nan"):
                    continue
                hg = row.get("FTHG")
                ag = row.get("FTAG")
                b365h = safe(row.get("B365H"))
                b365d = safe(row.get("B365D"))
                b365a = safe(row.get("B365A"))
                psh = safe(row.get("PSH"))
                psd = safe(row.get("PSD"))
                psa = safe(row.get("PSA"))
                avgh = safe(row.get("AvgH"))
                avgd = safe(row.get("AvgD"))
                avga = safe(row.get("AvgA"))
                over25 = safe(row.get("B365>2.5") if "B365>2.5" in cols else row.get("Over2.5"))
                under25 = safe(row.get("B365<2.5") if "B365<2.5" in cols else row.get("Under2.5"))
                btts_yes = safe(row.get("B365%>2.5") if "B365%>2.5" in cols else row.get("BTSyes"))
                btts_no = safe(row.get("B365%<2.5") if "B365%<2.5" in cols else row.get("BTSno"))

                try:
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO fd_history
                        (date, league, home_team, away_team, home_goals, away_goals,
                         b365h, b365d, b365a, psh, psd, psa, avgh, avgd, avga,
                         over25, under25, btts_yes, btts_no)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        (
                            date, lkey, home, away, safe(hg), safe(ag),
                            b365h, b365d, b365a, psh, psd, psa, avgh, avgd, avga,
                            over25, under25, btts_yes, btts_no,
                        ),
                    )
                    total += 1
                except Exception as e:
                    print("[BACKFILL] insert error:", e)
            print(f"[BACKFILL] {lkey} {season}: {len(df)} rows")

    conn.commit()
    conn.close()
    print(f"[BACKFILL] {total} lignes traitees -> {DB_PATH}")
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", nargs="*", default=ALL_SEASONS)
    ap.add_argument("--leagues", nargs="*", default=ALL_LEAGUES)
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()
    if args.all:
        seasons, leagues = ALL_SEASONS, ALL_LEAGUES
    else:
        seasons, leagues = args.seasons, args.leagues
    backfill(seasons, leagues)


if __name__ == "__main__":
    main()
