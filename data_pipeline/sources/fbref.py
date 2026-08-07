"""Stats avancées par match : xG & xA (+ buts) pour les ligues Top-5.

NOTE : FBref ne sert plus xG/xA dans son HTML public (vérifié le 07/08/2026 —
les pages 'matchlogs' et 'match report' ne contiennent aucune colonne xG).
Le fournisseur utilisé est donc Understat (API JSON, sans protection
Cloudflare), via soccerdata. Le débit est limité à ~15-20 requêtes/min
(intervalle de 3,5 s entre requêtes) conformément à la spécification.
"""
from __future__ import annotations

import json

import pandas as pd
import soccerdata as sd

from config import ADVANCED_CSV, LEAGUES, SOCCERDATA_CACHE, soccerdata_seasons
from util import RateLimiter, get_logger

log = get_logger("fbref")

XG_COLS = ["home_xg", "away_xg", "home_np_xg", "away_np_xg", "home_goals", "away_goals"]


def _patch_understat_rosters() -> None:
    """Corrige soccerdata 1.9.1 : rosters vides (listes) sur certains matchs.

    Understat renvoie parfois `rosters.h/a = []` (matchs récents sans lineups),
    alors que soccerdata attend un dict -> AttributeError. On saute ces matchs.
    """
    import soccerdata.understat as us_mod

    if getattr(us_mod.Understat, "_patched_read_match", False):
        return
    orig = us_mod.Understat._read_match

    def patched(self, url: str, match_id: int):
        self._ensure_cookies()
        try:
            api_url = us_mod.UNDERSTAT_URL + f"/getMatchData/{match_id}"
            filepath = self.data_dir / f"match_{match_id}.json"
            reader = self._request_api(api_url, filepath)
            data = json.load(reader)

            rosters = data["rosters"]
            rosters = {side: rosters.get(side) or {} for side in ("h", "a")}
            rosters = {side: (r if isinstance(r, dict) else {}) for side, r in rosters.items()}
            if not rosters["h"] or not rosters["a"]:
                return None

            home_team_name = self._extract_team_name(data["tmpl"]["home"])
            away_team_name = self._extract_team_name(data["tmpl"]["away"])
            home_team_id = next(iter(rosters["h"].values()))["team_id"]
            away_team_id = next(iter(rosters["a"].values()))["team_id"]

            return {
                "match_info": {
                    "h": home_team_id,
                    "a": away_team_id,
                    "team_h": home_team_name,
                    "team_a": away_team_name,
                },
                "rostersData": rosters,
                "shotsData": data["shots"],
            }
        except ConnectionError:
            return None

    patched.__name__ = orig.__name__
    us_mod.Understat._read_match = patched
    us_mod.Understat._patched_read_match = True


def fetch(leagues=None, seasons=None, limiter: RateLimiter | None = None, force: bool = False) -> pd.DataFrame:
    """Télécharge les stats avancées (xG/xA) par match pour les ligues/saisons."""
    leagues = leagues or LEAGUES
    seasons = seasons if seasons is not None else soccerdata_seasons()
    limiter = limiter or RateLimiter()
    names = [cfg["name"] for cfg in leagues.values()]

    _patch_understat_rosters()
    us = sd.Understat(leagues=names, seasons=seasons, data_dir=SOCCERDATA_CACHE)

    limiter.wait()
    tm = us.read_team_match_stats(force_cache=force)
    limiter.wait()
    pm = us.read_player_match_stats()

    tm = tm.reset_index()
    cols = [c for c in ["league", "season", "game", "game_id", "date", "home_team", "away_team"] + XG_COLS if c in tm.columns]
    base = tm[cols].copy()

    if "xa" in pm.columns:
        pm = pm.reset_index()
        team_xa = pm.groupby(["game_id", "team"])["xa"].sum().reset_index()
        base = base.merge(
            team_xa.rename(columns={"team": "home_team", "xa": "home_xa"}),
            on=["game_id", "home_team"], how="left",
        )
        base = base.merge(
            team_xa.rename(columns={"team": "away_team", "xa": "away_xa"}),
            on=["game_id", "away_team"], how="left",
        )
    else:
        base["home_xa"] = float("nan")
        base["away_xa"] = float("nan")

    base["date"] = pd.to_datetime(base["date"], errors="coerce").dt.floor("D")
    base["home_team"] = base["home_team"].fillna("").astype(str).str.strip()
    base["away_team"] = base["away_team"].fillna("").astype(str).str.strip()
    base = base[base["date"].notna() & base["home_team"].ne("") & base["away_team"].ne("")]
    base = base.drop_duplicates(["date", "home_team", "away_team"])

    ADVANCED_CSV.parent.mkdir(parents=True, exist_ok=True)
    base.to_csv(ADVANCED_CSV, index=False)
    log.info("Stats avancées : %d matchs", len(base))
    return base
