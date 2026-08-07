"""Football-Data.co.uk : résultats, cotes bookmakers et stats de match.

Téléchargement de CSV directs (aucun rate limit nécessaire), mis en cache sur
disque. La saison en cours est re-téléchargée à chaque exécution quotidienne.
"""
from __future__ import annotations

import io
from pathlib import Path

import pandas as pd
import requests

from config import FD_BASE_URL, FOOTBALL_DATA_DIR, LEAGUES, RAW_DIR, season_codes
from util import get_logger, retry

log = get_logger("football_data")


class SeasonNotFoundError(RuntimeError):
    """Le fichier CSV de la saison n'existe pas encore (saison non publiée)."""

RENAME = {
    "Date": "date",
    "HomeTeam": "home_team", "AwayTeam": "away_team",
    "FTHG": "fthg", "FTAG": "ftag", "FTR": "ftr",
    "HTHG": "hthg", "HTAG": "htag", "HTR": "htr",
    "HS": "hs", "AS": "away_shots", "HST": "hst", "AST": "ast",
    "HC": "hc", "AC": "ac", "HY": "hy", "AY": "ay",
    "HR": "hr", "AR": "ar", "HF": "hf", "AF": "af",
    "B365H": "odds_h_b365", "B365D": "odds_d_b365", "B365A": "odds_a_b365",
    "PSH": "odds_h_ps", "PSD": "odds_d_ps", "PSA": "odds_a_ps",
    "AvgH": "odds_h_avg", "AvgD": "odds_d_avg", "AvgA": "odds_a_avg",
    "MaxH": "odds_h_max", "MaxD": "odds_d_max", "MaxA": "odds_a_max",
}

BASE_COLS = ["league", "season", "date", "home_team", "away_team"]
NUM_COLS = list(RENAME.values())


@retry(n=4, delay=4, exceptions=(requests.RequestException,))
def _download(season_code: str, file_stem: str) -> bytes:
    url = f"{FD_BASE_URL}/{season_code}/{file_stem}.csv"
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
    if resp.status_code == 404:
        raise SeasonNotFoundError(url)
    resp.raise_for_status()
    return resp.content


def _read_csv(data: bytes | Path) -> pd.DataFrame:
    if isinstance(data, Path):
        df = pd.read_csv(data, encoding="utf-8-sig")
    else:
        df = pd.read_csv(io.BytesIO(data), encoding="utf-8-sig")
    return df.rename(columns=RENAME)


def _valid_div(df: pd.DataFrame, expected: str) -> bool:
    """Vérifie que le fichier correspond bien à la division attendue (colonne Div).

    Protège contre les fichiers mal étiquetés côté football-data.co.uk (ex. la
    saison 2627 où 'SP1' contenait des données écossaises Div=SC1).
    """
    if "Div" not in df.columns or df.empty:
        return False
    ratio = df["Div"].astype(str).str.strip().eq(expected).mean()
    return ratio >= 0.9


def fetch(leagues=None, force: bool = False) -> pd.DataFrame:
    """Télécharge les CSV Football-Data pour les ligues/saisons configurées."""
    leagues = leagues or LEAGUES
    codes = season_codes()
    frames = []
    for lkey, cfg in leagues.items():
        for code in codes:
            fpath = FOOTBALL_DATA_DIR / f"{cfg['fd_file']}_{code}.csv"
            is_current = code == codes[0]
            if fpath.exists() and not force and not is_current:
                df = _read_csv(fpath)
            else:
                try:
                    data = _download(code, cfg["fd_file"])
                except SeasonNotFoundError as exc:
                    log.info("Saison %s non publiée pour %s (%s) — ignorée", code, lkey, exc)
                    continue
                df = _read_csv(data)
                if not _valid_div(df, cfg["div"]):
                    log.warning("Fichier %s incohérent (Div attendu=%s) — ignoré", fpath, cfg["div"])
                    continue
                fpath.parent.mkdir(parents=True, exist_ok=True)
                fpath.write_bytes(data)
            df = df.copy()
            df["league"] = lkey
            df["season"] = code
            frames.append(df)

    if not frames:
        return pd.DataFrame()

    df = pd.concat(frames, ignore_index=True)
    for col in NUM_COLS:
        if col not in df.columns:
            df[col] = float("nan")
    df["date"] = pd.to_datetime(df["date"], format="%d/%m/%Y", errors="coerce")
    df["home_team"] = df["home_team"].fillna("").astype(str).str.strip()
    df["away_team"] = df["away_team"].fillna("").astype(str).str.strip()
    df = df[df["date"].notna() & df["home_team"].ne("") & df["away_team"].ne("")]
    cols = list(dict.fromkeys(c for c in BASE_COLS + NUM_COLS if c in df.columns))
    df = df[cols].drop_duplicates(
        subset=["league", "season", "date", "home_team", "away_team"]
    )
    out = RAW_DIR / "football_data_all.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out, index=False)
    log.info("Football-Data : %d matchs", len(df))
    return df
