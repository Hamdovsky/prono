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
    "F1":  {"name": "FRA-Ligue 1",       "fd_file": "F1",  "div": "F1",  "country": "FRA"},
    # -- Extension multi-ligues (expérience hybride "plus de données") --
    # Noms FBref = canoniques soccerdata ; si un nom est légèrement erroné, le xG
    # de CETTE ligue sera absent (odds+Elo restent) -> à vérifier via logs sur env réseau.
    "E1":  {"name": "ENG-Championship",   "fd_file": "E1",  "div": "E1",  "country": "ENG"},
    "E2":  {"name": "ENG-League One",     "fd_file": "E2",  "div": "E2",  "country": "ENG"},
    "SC0": {"name": "SCO-Premiership",     "fd_file": "SC0", "div": "SC0", "country": "SCO"},
    "D2":  {"name": "GER-Bundesliga 2",    "fd_file": "D2",  "div": "D2",  "country": "GER"},
    "I2":  {"name": "ITA-Serie B",         "fd_file": "I2",  "div": "I2",  "country": "ITA"},
    "SP2": {"name": "ESP-Segunda División","fd_file": "SP2", "div": "SP2", "country": "ESP"},
    "F2":  {"name": "FRA-Ligue 2",         "fd_file": "F2",  "div": "F2",  "country": "FRA"},
    "B1":  {"name": "BEL-Pro League",      "fd_file": "B1",  "div": "B1",  "country": "BEL"},
    "P1":  {"name": "POR-Primera Liga",    "fd_file": "P1",  "div": "P1",  "country": "POR"},
    "N1":  {"name": "NED-Eredivisie",      "fd_file": "N1",  "div": "N1",  "country": "NED"},
    "T1":  {"name": "TUR-Super Lig",       "fd_file": "T1",  "div": "T1",  "country": "TUR"},
    "G1":  {"name": "GRE-Super League 1",  "fd_file": "G1",  "div": "G1",  "country": "GRE"},
}

# Nombre de saisons complètes conservées en plus de la saison en cours
HISTORICAL_SEASONS = 3

# Rate limiting — stats avancées : ~15-20 requêtes/min (intervalle 3,5 s)
FBREF_INTERVAL_SECONDS = 3.5
FBREF_MAX_PER_MINUTE = 15
# ClubElo : API par équipe, léger délai par sécurité
CLUBELO_INTERVAL_SECONDS = 0.8

FD_BASE_URL = "https://www.football-data.co.uk/mmz4281"

# ── Gestion des proxies (Proxy Manager) ─────────────────────────────────────
# Sources de listes de proxies libres, re-vérifiées régulièrement par leurs
# mainteneurs. La liste est rafraîchie en mémoire toutes les PROXY_REFRESH_MIN.
PROXY_SOURCES = [
    "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
    "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt",
]
PROXY_REFRESH_MIN = 30                 # rafraîchissement du cache en mémoire
PROXY_FETCH_TIMEOUT = 10.0             # timeout pour télécharger les listes
PROXY_HEALTH_TIMEOUT = 3.0             # health-check court avant chaque usage
PROXY_MAX_ATTEMPTS = 4                 # nb max de proxies essayés par rotation
PROXY_RETRY_STATUS = (403, 429, 503)   # statuts HTTP déclenchant la rotation


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
