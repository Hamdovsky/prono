"""ClubElo : rating Elo pré-match (avant chaque match) pour chaque équipe.

Chaîne de résilience :
  1. API api.clubelo.com — historique Elo complet par équipe (lookup 'as-of'
     à la date du match pour obtenir le rating juste avant le coup d'envoi) ;
  2. Cache local (data/raw/clubelo/elo_history.csv) si l'API est indisponible ;
  3. Calcul local de l'Elo depuis les résultats si aucun historique n'existe.

Le calcul local utilise l'algorithme Elo standard (K=20, avantage domicile
+100, 1500 initial) et sert uniquement de repli quand ClubElo est injoignable.
"""
from __future__ import annotations

from datetime import datetime
import socket

import numpy as np
import pandas as pd
import soccerdata as sd

from config import CLUBELO_DIR, LEAGUES, SOCCERDATA_CACHE
from util import RateLimiter, get_logger

log = get_logger("clubelo")


def current_teams(countries=None) -> list[str]:
    """Équipes actuelles de 1re division pour les pays des ligues configurées."""
    countries = countries or {cfg["country"] for cfg in LEAGUES.values()}
    ce = sd.ClubElo(data_dir=SOCCERDATA_CACHE)
    ratings = ce.read_by_date()
    country = ratings.get("country", pd.Series(dtype=object))
    level = ratings.get("level", pd.Series(dtype=float))
    return ratings[country.isin(countries) & level.eq(1)].index.tolist()


def _fetch_from_api(limiter: RateLimiter, max_age: int) -> pd.DataFrame:
    ce = sd.ClubElo(data_dir=SOCCERDATA_CACHE)
    teams = current_teams()
    frames = []
    for team in teams:
        limiter.wait()
        try:
            hist = ce.read_team_history(team, max_age=max_age)
        except Exception as exc:  # noqa: BLE001
            log.warning("ClubElo : historique indisponible pour %r (%s)", team, exc)
            continue
        hist = hist.reset_index()
        keep = [c for c in ["from", "elo"] if c in hist.columns]
        frame = hist[keep].copy()
        frame["team_raw"] = team
        frames.append(frame)

    if not frames:
        raise RuntimeError("Aucun historique ClubElo téléchargé")

    hist = pd.concat(frames, ignore_index=True)
    hist["from"] = pd.to_datetime(hist["from"], errors="coerce")
    hist = hist[hist["from"].notna()].sort_values("from")
    hist.to_csv(CLUBELO_DIR / "elo_history.csv", index=False)
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
    hist.to_csv(CLUBELO_DIR / "elo_history.csv", index=False)
    log.info("ClubElo (local) : %d relevés calculés", len(hist))
    return hist


def _fallback(exc: Exception, max_age: int,
              fallback_results: pd.DataFrame | None) -> pd.DataFrame:
    log.warning("API ClubElo indisponible : %s", exc)
    cached = CLUBELO_DIR / "elo_history.csv"
    if cached.exists():
        age_days = (datetime.now() - datetime.fromtimestamp(cached.stat().st_mtime)).days
        if age_days <= max_age:
            log.info("Utilisation du cache ClubElo local (%s)", cached)
            return pd.read_csv(cached, parse_dates=["from"])
    if fallback_results is not None and len(fallback_results):
        return compute_elo(fallback_results)
    raise


def fetch_histories(limiter: RateLimiter | None = None, max_age: int = 1,
                    fallback_results: pd.DataFrame | None = None) -> pd.DataFrame:
    """Historique Elo par équipe, avec repli cache puis calcul local."""
    limiter = limiter or RateLimiter(0.0)
    CLUBELO_DIR.mkdir(parents=True, exist_ok=True)
    if not _api_reachable():
        return _fallback(RuntimeError("api.clubelo.com injoignable (check DNS)"),
                         max_age, fallback_results)
    try:
        return _fetch_from_api(limiter, max_age)
    except Exception as exc:  # noqa: BLE001
        return _fallback(exc, max_age, fallback_results)


def _api_reachable() -> bool:
    """Check DNS/TCP rapide pour éviter les longues retries quand l'API est down."""
    try:
        socket.create_connection(("api.clubelo.com", 80), timeout=5).close()
        return True
    except OSError:
        return False
