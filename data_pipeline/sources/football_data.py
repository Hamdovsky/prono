"""Football-Data.co.uk : résultats, cotes bookmakers et stats de match.

Téléchargement de CSV directs (aucun rate limit nécessaire), mis en cache sur
disque. La saison en cours est re-téléchargée à chaque exécution quotidienne.
"""
from __future__ import annotations

import io
from pathlib import Path

import pandas as pd
import requests

from .base import BaseSource, KIND_BASE
from config import FD_BASE_URL, FOOTBALL_DATA_DIR, LEAGUES, RAW_DIR, season_codes
from util import get_logger, retry

log = get_logger("football_data")


class SeasonNotFoundError(RuntimeError):
    """Le fichier CSV de la saison n'existe pas encore (saison non publiée)."""

RENAME = {
    "Date": "date",
    "HomeTeam": "home_team", "AwayTeam": "away_team",
    "Time": "kickoff_time",
    "FTHG": "fthg", "FTAG": "ftag", "FTR": "ftr",
    "HTHG": "hthg", "HTAG": "htag", "HTR": "htr",
    "HS": "hs", "AS": "away_shots", "HST": "hst", "AST": "ast",
    "HC": "hc", "AC": "ac", "HY": "hy", "AY": "ay",
    "HR": "hr", "AR": "ar", "HF": "hf", "AF": "af",
    # Cotes d'ouverture 1X2
    "B365H": "odds_h_b365", "B365D": "odds_d_b365", "B365A": "odds_a_b365",
    "BFDH": "odds_h_bfd", "BFDD": "odds_d_bfd", "BFDA": "odds_a_bfd",
    "PSH": "odds_h_ps", "PSD": "odds_d_ps", "PSA": "odds_a_ps",
    "BWH": "odds_h_bw", "BWD": "odds_d_bw", "BWA": "odds_a_bw",
    "MaxH": "odds_h_max", "MaxD": "odds_d_max", "MaxA": "odds_a_max",
    "AvgH": "odds_h_avg", "AvgD": "odds_d_avg", "AvgA": "odds_a_avg",
    # Cotes fermées (close) 1X2
    "B365CH": "odds_h_close_b365", "B365CD": "odds_d_close_b365", "B365CA": "odds_a_close_b365",
    "BFDCH": "odds_h_close_bfd", "BFDCD": "odds_d_close_bfd", "BFDCA": "odds_a_close_bfd",
    "PSCH": "odds_h_close_ps", "PSCD": "odds_d_close_ps", "PSCA": "odds_a_close_ps",
    "BWCH": "odds_h_close_bw", "BWCD": "odds_d_close_bw", "BWCA": "odds_a_close_bw",
    "MaxCH": "odds_h_close_max", "MaxCD": "odds_d_close_max", "MaxCA": "odds_a_close_max",
    "AvgCH": "odds_h_close_avg", "AvgCD": "odds_d_close_avg", "AvgCA": "odds_a_close_avg",
    # Totaux >2.5 buts (ouverture + fermé)
    "B365>2.5": "odds_o25_b365", "B365<2.5": "odds_u25_b365",
    "P>2.5": "odds_o25_ps", "P<2.5": "odds_u25_ps",
    "Max>2.5": "odds_o25_max", "Max<2.5": "odds_u25_max",
    "Avg>2.5": "odds_o25_avg", "Avg<2.5": "odds_u25_avg",
    "B365C>2.5": "odds_o25_close_b365", "B365C<2.5": "odds_u25_close_b365",
    "AvgC>2.5": "odds_o25_close_avg", "AvgC<2.5": "odds_u25_close_avg",
    # Handicap asiatique (ouverture + fermé)
    "AHh": "ah_line", "AHCh": "ah_line_close",
    "B365AHH": "odds_ah_h_b365", "B365AHA": "odds_ah_a_b365",
    "B365CAHH": "odds_ah_h_close_b365", "B365CAHA": "odds_ah_a_close_b365",
    "AvgAHH": "odds_ah_h_avg", "AvgAHA": "odds_ah_a_avg",
    "AvgCAHH": "odds_ah_h_close_avg", "AvgCAHA": "odds_ah_a_close_avg",
}

BASE_COLS = ["league", "season", "date", "home_team", "away_team"]
NUM_COLS = list(RENAME.values())

# Fixtures (matchs à venir) : PP/SKB au lieu de PS, et pas de colonnes résultats
RENAME_FIXTURES = {
    "PPH": "odds_h_pp", "PPD": "odds_d_pp", "PPA": "odds_a_pp",
    "SKBH": "odds_h_skb", "SKBD": "odds_d_skb", "SKBA": "odds_a_skb",
}
FIXTURE_EXTRA_COLS = [
    "Referee", "odds_h_pp", "odds_d_pp", "odds_a_pp",
    "odds_h_skb", "odds_d_skb", "odds_a_skb",
]


@retry(n=4, delay=4, exceptions=(requests.RequestException,))
def _download(season_code: str, file_stem: str) -> bytes:
    url = f"{FD_BASE_URL}/{season_code}/{file_stem}.csv"
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
    # Un fichier de saison pas encore publié peut répondre 404, 300 ou un HTML
    # d'erreur — on le traite comme "saison non publiée" (pas un crash).
    if resp.status_code == 404 or resp.status_code >= 300:
        raise SeasonNotFoundError(url)
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
                try:
                    df = _read_csv(data)
                except Exception as exc:
                    # Fichier courant malformé (page HTML, colonnes absentes…) :
                    # on ignore plutôt que de casser toute la récolte.
                    log.warning("Fichier %s illisible (%s) — ignoré", fpath, exc)
                    continue
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


FIXTURES_CSV = RAW_DIR / "football_data_fixtures.csv"
FIXTURES_URL = "https://www.football-data.co.uk/fixtures.csv"


@retry(n=3, delay=3, exceptions=(requests.RequestException,))
def _download_fixtures() -> bytes:
    resp = requests.get(FIXTURES_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    resp.raise_for_status()
    return resp.content


def fetch_fixtures(leagues=None, force: bool = False) -> pd.DataFrame:
    """Cotes réelles des matchs à venir (fixtures.csv, 1X2 + totaux + AH).

    Source fiable (même domaine que les CSV de résultats). Utilisée par le
    quotidien pour fournir les cotes réelles des prochains matchs des Top-5.
    """
    leagues = leagues or LEAGUES
    data = _download_fixtures()
    df = pd.read_csv(io.BytesIO(data), encoding="utf-8-sig")
    df = df.rename(columns={**RENAME, **RENAME_FIXTURES})
    df["league"] = df["Div"].astype(str).str.strip()
    rev = {cfg["div"]: lkey for lkey, cfg in leagues.items()}
    df["league"] = df["league"].map(rev)
    df = df[df["league"].notna()]

    for col in NUM_COLS + FIXTURE_EXTRA_COLS:
        if col not in df.columns:
            df[col] = float("nan")
    df["date"] = pd.to_datetime(df["date"], format="%d/%m/%Y", errors="coerce")
    df["home_team"] = df["home_team"].fillna("").astype(str).str.strip()
    df["away_team"] = df["away_team"].fillna("").astype(str).str.strip()
    df = df[df["date"].notna() & df["home_team"].ne("") & df["away_team"].ne("")]
    df["season"] = "fixtures"

    cols = list(dict.fromkeys(c for c in BASE_COLS + NUM_COLS + FIXTURE_EXTRA_COLS if c in df.columns))
    df = df[cols].drop_duplicates(subset=["date", "home_team", "away_team"])
    df = df.sort_values(["date", "kickoff_time"]).reset_index(drop=True)

    FIXTURES_CSV.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(FIXTURES_CSV, index=False)
    log.info("Football-Data fixtures : %d matchs à venir (cotes %s)", len(df),
             "officielles" if len(df) else "aucune")
    return df


class FootballDataSource(BaseSource):
    """Source Football-Data.co.uk sous le contrat homogène (résultats + fixtures).

    Authentifie le registre ``SOURCES`` ; la logique de récolte reste dans les
    fonctions module `fetch` / `fetch_fixtures` (rétro-compat des tests).
    """

    name = "football_data"
    kind = KIND_BASE
    rate_limit_s = 0.0  # CSV directs, aucun rate limit nécessaire

    def _fetch(self, leagues=None, seasons=None, force: bool = False):
        df = fetch(leagues=leagues, force=force)
        return df, "football-data.co.uk", []

    def fetch_fixtures(self, leagues=None, force: bool = False):
        """Cotes officielles des matchs à venir (même source, sans rate limit)."""
        return fetch_fixtures(leagues=leagues, force=force)
