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

# Ligues 2026-08-29 — расширенные для максимального покрытия (30+ лиг)
# football-data.co.uk охватывает ~50 лиг. Добавляем все доступные.
LEAGUES = {
    # === TOP-5 EUROPE ===
    "E0":  {"name": "ENG-Premier League",    "fd_file": "E0",  "div": "E0",  "country": "ENG"},
    "SP1": {"name": "ESP-La Liga",          "fd_file": "SP1", "div": "SP1", "country": "ESP"},
    "I1":  {"name": "ITA-Serie A",          "fd_file": "I1",  "div": "I1",  "country": "ITA"},
    "D1":  {"name": "GER-Bundesliga",       "fd_file": "D1",  "div": "D1",  "country": "GER"},
    "F1":  {"name": "FRA-Ligue 1",          "fd_file": "F1",  "div": "F1",  "country": "FRA"},
    # === DIVISION INFERIEURES EUROPE ===
    "E1":  {"name": "ENG-Championship",      "fd_file": "E1",  "div": "E1",  "country": "ENG"},
    "E2":  {"name": "ENG-League One",        "fd_file": "E2",  "div": "E2",  "country": "ENG"},
    "E3":  {"name": "ENG-League Two",        "fd_file": "E3",  "div": "E3",  "country": "ENG"},
    "EC":  {"name": "ENG-National League",   "fd_file": "EC",  "div": "EC",  "country": "ENG"},
    "SP2": {"name": "ESP-Segunda División", "fd_file": "SP2", "div": "SP2", "country": "ESP"},
    "I2":  {"name": "ITA-Serie B",           "fd_file": "I2",  "div": "I2",  "country": "ITA"},
    "D2":  {"name": "GER-2. Bundesliga",     "fd_file": "D2",  "div": "D2",  "country": "GER"},
    "F2":  {"name": "FRA-Ligue 2",           "fd_file": "F2",  "div": "F2",  "country": "FRA"},
    # === EUROPE REST ===
    "SC0": {"name": "SCO-Premiership",      "fd_file": "SC0", "div": "SC0", "country": "SCO"},
    "SC1": {"name": "SCO-Championship",      "fd_file": "SC1", "div": "SC1", "country": "SCO"},
    "SC2": {"name": "SCO-League One",       "fd_file": "SC2", "div": "SC2", "country": "SCO"},
    "SC3": {"name": "SCO-League Two",       "fd_file": "SC3", "div": "SC3", "country": "SCO"},
    "B1":  {"name": "BEL-Pro League",        "fd_file": "B1",  "div": "B1",  "country": "BEL"},
    "P1":  {"name": "POR-Primera Liga",     "fd_file": "P1",  "div": "P1",  "country": "POR"},
    "P2":  {"name": "POR-Segunda Liga",     "fd_file": "P2",  "div": "P2",  "country": "POR"},
    "N1":  {"name": "NED-Eredivisie",       "fd_file": "N1",  "div": "N1",  "country": "NED"},
    "N2":  {"name": "NED-Eerste Divisie",   "fd_file": "N2",  "div": "N2",  "country": "NED"},
    "T1":  {"name": "TUR-Süper Lig",         "fd_file": "T1",  "div": "T1",  "country": "TUR"},
    "T2":  {"name": "TUR-TFF First League", "fd_file": "T2",  "div": "T2",  "country": "TUR"},
    "G1":  {"name": "GRE-Super League 1",   "fd_file": "G1",  "div": "G1",  "country": "GRE"},
    "G2":  {"name": "GRE-Super League 2",    "fd_file": "G2",  "div": "G2",  "country": "GRE"},
    "A1":  {"name": "AUT-Bundesliga",        "fd_file": "A1",  "div": "A1",  "country": "AUT"},
    "A2":  {"name": "AUT-2. Liga",           "fd_file": "A2",  "div": "A2",  "country": "AUT"},
    "C1":  {"name": "CZE-Czech Liga",       "fd_file": "C1",  "div": "C1",  "country": "CZE"},
    "C2":  {"name": "CZE-Czech Liga 2",     "fd_file": "C2",  "div": "C2",  "country": "CZE"},
    "DK1": {"name": "DEN-Superliga",         "fd_file": "DK1", "div": "DK1", "country": "DEN"},
    "DK2": {"name": "DEN-1. Division",       "fd_file": "DK2", "div": "DK2", "country": "DEN"},
    "NO1": {"name": "NOR-Eliteserien",       "fd_file": "NO1", "div": "NO1", "country": "NOR"},
    "NO2": {"name": "NOR-1. Division",       "fd_file": "NO2", "div": "NO2", "country": "NOR"},
    "SE1": {"name": "SWE-Allsvenskan",       "fd_file": "SE1", "div": "SE1", "country": "SWE"},
    "SE2": {"name": "SWE-Superettan",        "fd_file": "SE2", "div": "SE2", "country": "SWE"},
    "FI1": {"name": "FIN-Veikkausliiga",    "fd_file": "FI1", "div": "FI1", "country": "FIN"},
    "IRL1":{"name": "IRL-Premier Division",   "fd_file": "IRL1","div": "IRL1","country": "IRL"},
    "IRL2":{"name": "IRL-First Division",    "fd_file": "IRL2","div": "IRL2","country": "IRL"},
    "PL1": {"name": "POL-Ekstraklasa",       "fd_file": "PL1", "div": "PL1", "country": "POL"},
    "PL2": {"name": "POL-I Liga",             "fd_file": "PL2", "div": "PL2", "country": "POL"},
    "RO1": {"name": "ROU-Liga 1",            "fd_file": "RO1", "div": "RO1", "country": "ROU"},
    "RO2": {"name": "ROU-Liga 2",            "fd_file": "RO2", "div": "RO2", "country": "ROU"},
    "UKR1":{"name": "UKR-Premier League",    "fd_file": "UKR1","div": "UKR1","country": "UKR"},
    "UKR2":{"name": "UKR-Persha Liga",       "fd_file": "UKR2","div": "UKR2","country": "UKR"},
    "RUS1":{"name": "RUS-Premier League",    "fd_file": "RUS1","div": "RUS1","country": "RUS"},
    "CHI1":{"name": "CHN-Super League",      "fd_file": "CHI1","div": "CHI1","country": "CHN"},
    "JPN1":{"name": "JPN-J1 League",          "fd_file": "JPN1","div": "JPN1","country": "JPN"},
    "JPN2":{"name": "JPN-J2 League",          "fd_file": "JPN2","div": "JPN2","country": "JPN"},
    "KOR1":{"name": "KOR-K League 1",        "fd_file": "KOR1","div": "KOR1","country": "KOR"},
    "USA1":{"name": "USA-MLS",               "fd_file": "USA1","div": "USA1","country": "USA"},
    "USA2":{"name": "USA-MLS Next Pro",      "fd_file": "USA2","div": "USA2","country": "USA"},
    "MEX1":{"name": "MEX-Liga MX",           "fd_file": "MEX1","div": "MEX1","country": "MEX"},
    "BRA1":{"name": "BRA-Série A",           "fd_file": "BRA1","div": "BRA1","country": "BRA"},
    "BRA2":{"name": "BRA-Série B",           "fd_file": "BRA2","div": "BRA2","country": "BRA"},
    "ARG1":{"name": "ARG-Liga Profesional",  "fd_file": "ARG1","div": "ARG1","country": "ARG"},
    "AUS1":{"name": "AUS-A-League",          "fd_file": "AUS1","div": "AUS1","country": "AUS"},
    # === EUROPEAN CUPS ===
    "ELC": {"name": "UEFA-Champions League",  "fd_file": "ELC", "div": "ELC", "country": "EUR"},
    "UEL": {"name": "UEFA-Europa League",     "fd_file": "EC",  "div": "EC",  "country": "EUR"},
    "EUC": {"name": "UEFA-Conference League", "fd_file": "EUC", "div": "EUC", "country": "EUR"},
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
