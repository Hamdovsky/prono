"""Configuration centrale du pipeline de données pronos.

Sources :
  - Football-Data.co.uk : résultats + cotes + stats de match (CSV quotidiens)
  - ClubElo            : rating Elo pré-match (api.clubelo.com, HTTP direct)
  - Stats avancées     : xG/xA par match (FBref via soccerdata — fonctionnel ;
                         repli cache local, puis Understat en dernier recours)

Chemins (raccourcis) :
  - advanced_stats.csv : xG/xA brut (FBref, repli Understat)
  - master_dataset.csv : master final (143 colonnes, featured + Elo as-of)
  - state.json         : horodatage des dernières exécutions (git-ignoré)
"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
DATA_DIR = PACKAGE_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
SOCCERDATA_CACHE = DATA_DIR / "soccerdata_cache"
SOFASCORE_CACHE = SOCCERDATA_CACHE / "Sofascore"
FOOTBALL_DATA_DIR = RAW_DIR / "football_data"
CLUBELO_DIR = RAW_DIR / "clubelo"

ADVANCED_CSV = RAW_DIR / "advanced_stats.csv"
MASTER_CSV = PROCESSED_DIR / "master_dataset.csv"
MASTER_DB = PROCESSED_DIR / "master.db"
STATE_FILE = DATA_DIR / "state.json"
ALIASES_FILE = DATA_DIR / "team_aliases.json"
SCHEMA_FILE = PACKAGE_DIR / "schema.sql"

# Ligues Top-5 (clé pipeline -> configuration)
LEAGUES = {
    "E0":  {"name": "ENG-Premier League", "fd_file": "E0",  "div": "E0",  "country": "ENG"},
    "SP1": {"name": "ESP-La Liga",        "fd_file": "SP1", "div": "SP1", "country": "ESP"},
    "I1":  {"name": "ITA-Serie A",        "fd_file": "I1",  "div": "I1",  "country": "ITA"},
    "D1":  {"name": "GER-Bundesliga",     "fd_file": "D1",  "div": "D1",  "country": "GER"},
    "F1":  {"name": "FRA-Ligue 1",        "fd_file": "F1",  "div": "F1",  "country": "FRA"},
}

# Nombre de saisons complètes conservées en plus de la saison en cours
HISTORICAL_SEASONS = 3

# Rate limiting — stats avancées : ~15-20 requêtes/min (intervalle 3,5 s)
FBREF_INTERVAL_SECONDS = 3.5
FBREF_MAX_PER_MINUTE = 15
# ClubElo : API par équipe, léger délai par sécurité
CLUBELO_INTERVAL_SECONDS = 0.8

FD_BASE_URL = "https://www.football-data.co.uk/mmz4281"


def current_season_years(now: datetime | None = None) -> tuple[int, int]:
    """Années de début/fin de la saison en cours (les saisons démarrent en août)."""
    now = now or datetime.utcnow()
    start = now.year if now.month >= 8 else now.year - 1
    return start, start + 1


def season_codes() -> list[str]:
    """Codes 'YYZZ' des saisons Football-Data, de la plus récente à la plus ancienne."""
    start, _ = current_season_years()
    return [f"{s % 100:02d}{(s + 1) % 100:02d}" for s in range(start, start - HISTORICAL_SEASONS - 1, -1)]


def soccerdata_seasons() -> list[int]:
    """Années de saison soccerdata (2024 = saison 2425), de la plus récente à la plus ancienne.

    Aligné sur season_codes() : saison en cours + HISTORICAL_SEASONS historiques.
    """
    start, _ = current_season_years()
    return list(range(start - HISTORICAL_SEASONS, start + 1))


def soccerdata_current_season() -> list[int]:
    """Année de début de la saison en cours côté soccerdata (ex. [2026] = 2627)."""
    start, _ = current_season_years()
    return [start]
