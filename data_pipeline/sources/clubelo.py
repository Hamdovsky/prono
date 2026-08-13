"""ClubElo : rating Elo pré-match (avant chaque match) pour chaque équipe.

Accès API en HTTP direct (urllib, port 80) : soccerdata a été abandonné pour
cette source car son client TLS (tls_requests) ralentit chaque requête à ~18 s
et échoue sur les noms d'équipe composés. L'API répond 403 sur la racine "/"
et le port 443 est bloqué en amont ; les paths de données (`/YYYY-MM-DD`,
`/{Club sans espace}`) répondent en HTTP.

Chaîne de résilience :
  1. Cache officiel frais (data/raw/clubelo/elo_history.csv) s'il a < max_age j ;
  2. API api.clubelo.com — historique Elo complet par équipe (lookup 'as-of'
     à la date du match pour obtenir le rating juste avant le coup d'envoi) ;
  3. Cache local (data/raw/clubelo/elo_history_local.csv) ;
  4. Calcul local de l'Elo depuis les résultats si aucun historique n'existe.

Le calcul local utilise l'algorithme Elo standard (K=20, avantage domicile
+100, 1500 initial) et sert uniquement de repli quand ClubElo est injoignable.

Provenance (retournée par fetch_histories et tracée dans le master via
`elo_source`) :
  - "clubelo" : ratings officiels récupérés à l'instant depuis l'API ;
  - "cache"   : historique officiel ClubElo en cache (récupéré un jour précédent) ;
  - "local"   : Elo calculé localement (repli, l'API étant injoignable).
"""
from __future__ import annotations

import io
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import numpy as np
import pandas as pd
import requests

from .base import BaseSource, KIND_ELO
from config import CLUBELO_DIR, CLUBELO_INTERVAL_SECONDS, LEAGUES, STATE_FILE
from util import RateLimiter, get_logger

log = get_logger("clubelo")

ELO_SOURCES = ("clubelo", "cache", "local")
_SOURCE_MARKER = "elo_source.txt"
# Caches distincts pour ne jamais écraser les ratings officiels :
# - elo_history.csv        -> historique officiel ClubElo (API)
# - elo_history_local.csv  -> Elo calculé localement (repli)
ELO_CACHE_OFFICIAL = "elo_history.csv"
ELO_CACHE_LOCAL = "elo_history_local.csv"


def _marker_path() -> Path:
    return CLUBELO_DIR / _SOURCE_MARKER


def _write_source(source: str) -> None:
    CLUBELO_DIR.mkdir(parents=True, exist_ok=True)
    _marker_path().write_text(source, encoding="utf-8")


def _read_source(default: str = "local") -> str:
    try:
        return _marker_path().read_text(encoding="utf-8").strip()
    except OSError:
        return default


def _http_get(path: str, timeout: float = 20.0) -> str:
    """GET HTTP sur l'API ClubElo (port 80, le 443 étant souvent bloqué en amont)."""
    url = f"http://api.clubelo.com{path}"
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=timeout)
    resp.raise_for_status()
    return resp.content.decode("utf-8", errors="replace")


def current_teams(countries=None) -> list[str]:
    """Équipes actuelles de 1re division pour les pays des ligues configurées.

    L'API ClubElo sert chaque jour un CSV de tous les clubs (`/{YYYY-MM-DD}`)
    dont la colonne `Club` porte le nom canonique court utilisé dans les URLs
    (ex. "Man City", "Real Madrid").
    """
    countries = countries or {cfg["country"] for cfg in LEAGUES.values()}
    today = datetime.utcnow().strftime("%Y-%m-%d")
    ratings = pd.read_csv(io.StringIO(_http_get(f"/{today}")))
    country = ratings.get("Country", pd.Series(dtype=object))
    level = ratings.get("Level", pd.Series(dtype=float))
    return ratings[country.isin(countries) & level.eq(1)]["Club"].astype(str).str.strip().tolist()


def _team_path_candidates(club: str) -> list[str]:
    """Chemins API possibles pour l'historique d'un club, par ordre de fiabilité.

    Le site ClubElo génère les URLs d'équipe en retirant les espaces du nom
    canonique ("Man City" -> /ManCity). Repli sur le nom encodé avec espaces
    pour les clubs aux caractères inhabituels (accents).
    """
    return [
        "/" + re.sub(r"[^a-zA-Z0-9-]", "", club),
        "/" + quote(club),
    ]


def _fetch_team_history(club: str) -> pd.DataFrame | None:
    """Historique Elo complet d'un club (CSV API : From, To, Elo, ...)."""
    for path in _team_path_candidates(club):
        try:
            hist = pd.read_csv(io.StringIO(_http_get(path)))
        except Exception as exc:  # noqa: BLE001
            log.debug("ClubElo : requête %s échouée (%s)", path, exc)
            continue
        if not hist.empty:
            frame = hist[["From", "Elo"]].rename(columns={"From": "from", "Elo": "elo"})
            frame["team_raw"] = club
            return frame
    return None


def _fetch_from_api(limiter: RateLimiter, max_age: int) -> pd.DataFrame:
    teams = current_teams()
    frames = []
    for club in teams:
        limiter.wait()
        try:
            frame = _fetch_team_history(club)
        except Exception as exc:  # noqa: BLE001
            log.warning("ClubElo : historique indisponible pour %r (%s)", club, exc)
            continue
        if frame is None or frame.empty:
            log.debug("ClubElo : aucun historique pour %r", club)
            continue
        frames.append(frame)

    if not frames:
        raise RuntimeError("Aucun historique ClubElo téléchargé")

    hist = pd.concat(frames, ignore_index=True)
    hist["from"] = pd.to_datetime(hist["from"], errors="coerce")
    hist = hist[hist["from"].notna()].sort_values("from")
    hist.to_csv(CLUBELO_DIR / ELO_CACHE_OFFICIAL, index=False)
    log.info("ClubElo (API) : %d relevés pour %d équipes", len(hist), hist["team_raw"].nunique())
    return hist


def compute_elo(results: pd.DataFrame, init: float = 1500.0, k: float = 20.0,
                home_adv: float = 100.0) -> pd.DataFrame:
    """Elo local calculé chronologiquement depuis les résultats (repli)."""
    df = results.sort_values(["date", "season", "league"]).reset_index(drop=True)
    rating: dict[str, float] = {}
    rows: list[dict] = []
    result_map = {"H": 1.0, "D": 0.5, "A": 0.0}

    for _, m in df.iterrows():
        home, away = m["home_team"], m["away_team"]
        elo_home = rating.get(home, init)
        elo_away = rating.get(away, init)
        rows.append({"from": m["date"], "elo": elo_home, "team_raw": home})
        rows.append({"from": m["date"], "elo": elo_away, "team_raw": away})

        exp_home = 1.0 / (1.0 + 10 ** ((elo_away - (elo_home + home_adv)) / 400.0))
        exp_away = 1.0 - exp_home
        score_home = result_map.get(m["ftr"], 0.5)
        rating[home] = elo_home + k * (score_home - exp_home)
        rating[away] = elo_away + k * ((1.0 - score_home) - exp_away)

    hist = pd.DataFrame(rows)
    hist["from"] = pd.to_datetime(hist["from"], errors="coerce")
    hist = hist[hist["from"].notna()].sort_values("from")
    hist.to_csv(CLUBELO_DIR / ELO_CACHE_LOCAL, index=False)
    log.info("ClubElo (local) : %d relevés calculés", len(hist))
    return hist


def _load_cache(name: str, max_age: int) -> pd.DataFrame | None:
    """Charge un cache ClubElo s'il existe et est encore frais."""
    path = CLUBELO_DIR / name
    if not path.exists():
        return None
    age_days = (datetime.now() - datetime.fromtimestamp(path.stat().st_mtime)).days
    if age_days > max_age:
        log.info("Cache ClubElo %s trop ancien (%d jours > %d)", name, age_days, max_age)
        return None
    return pd.read_csv(path, parse_dates=["from"])


def _fallback(exc: Exception, max_age: int,
              fallback_results: pd.DataFrame | None) -> tuple[pd.DataFrame, str]:
    log.warning("API ClubElo indisponible : %s", exc)
    # 1. Cache officiel ClubElo (récupéré un jour où l'API a tourné)
    official = _load_cache(ELO_CACHE_OFFICIAL, max_age)
    if official is not None and len(official):
        source = "cache"
        log.info("Utilisation du cache officiel ClubElo (%s, provenance=%s)",
                 ELO_CACHE_OFFICIAL, source)
        _write_source(source)
        return official, source
    # 2. Cache local (Elo calculé précédemment à partir des résultats)
    local = _load_cache(ELO_CACHE_LOCAL, max_age)
    if local is not None and len(local):
        source = "local"
        log.info("Utilisation du cache Elo local (%s, provenance=%s)", ELO_CACHE_LOCAL, source)
        _write_source(source)
        return local, source
    # 3. Recalcul local depuis les résultats
    if fallback_results is not None and len(fallback_results):
        hist = compute_elo(fallback_results)
        _write_source("local")
        return hist, "local"
    raise exc


def fetch_histories(limiter: RateLimiter | None = None, max_age: int = 1,
                    fallback_results: pd.DataFrame | None = None) -> tuple[pd.DataFrame, str]:
    """Historique Elo par équipe, avec repli cache puis calcul local.

    Retourne `(df, source)` où `source` ∈ {"clubelo", "cache", "local"}.
    """
    limiter = limiter or RateLimiter(0.0)
    CLUBELO_DIR.mkdir(parents=True, exist_ok=True)
    # 1. Cache officiel frais (récupéré lors d'un run API réussi récent) :
    #    évite de re-télécharger ~100 historiques à chaque exécution du jour.
    official = _load_cache(ELO_CACHE_OFFICIAL, max_age)
    if official is not None and len(official):
        log.info("ClubElo : réutilisation du cache officiel frais (%s)", ELO_CACHE_OFFICIAL)
        _write_source("cache")
        return official, "cache"
    # 2. API
    if not _api_reachable():
        return _fallback(RuntimeError("api.clubelo.com injoignable (probe HTTP)"),
                         max_age, fallback_results)
    try:
        hist = _fetch_from_api(limiter, max_age)
        _write_source("clubelo")
        return hist, "clubelo"
    except Exception as exc:  # noqa: BLE001
        return _fallback(exc, max_age, fallback_results)


def _api_reachable(timeout: float = 10.0) -> bool:
    """Vérifie si l'API ClubElo est réellement exploitable.

    On probe le path de ratings du jour (`/{YYYY-MM-DD}`, données réelles) avec
    le MÊME mécanisme urllib que le fetcher : c'est le seul moyen fiable de
    refléter la disponibilité réelle. La racine "/" répond 403 et le port 443
    est souvent bloqué en amont, donc ni l'un ni l'autre n'est utilisable comme
    sonde.
    """
    today = datetime.utcnow().strftime("%Y-%m-%d")
    try:
        ratings = pd.read_csv(io.StringIO(_http_get(f"/{today}", timeout=timeout)))
        return not ratings.empty
    except Exception:  # noqa: BLE001
        return False


class ClubEloSource(BaseSource):
    """Source ClubElo sous le contrat homogène (historique Elo pré-match).

    La chaîne de résilience (API -> cache officiel -> cache local -> calcul
    local) reste dans `fetch_histories` ; le pipeline injecte les résultats
    Football-Data via ``fallback_results`` avant d'appeler ``fetch``.
    """

    name = "clubelo"
    kind = KIND_ELO
    rate_limit_s = CLUBELO_INTERVAL_SECONDS

    def __init__(self, state_file=STATE_FILE):
        super().__init__(state_file)
        self.fallback_results: pd.DataFrame | None = None

    def _fetch(self, leagues=None, seasons=None, force: bool = False):
        df, source = fetch_histories(
            limiter=RateLimiter(0.0),  # le rate limit est déjà appliqué par BaseSource
            max_age=1,
            fallback_results=self.fallback_results,
        )
        warnings = [] if source != "local" else ["Elo local (repli) : ratings non officiels"]
        return df, source, warnings
