"""Stats avancées par match : xG & xA (+ buts) pour les ligues Top-5.

Fournisseur de xG :
  1. FBref (via soccerdata) — tenté en premier ;
  2. Understat (via soccerdata) — repli automatique si FBref échoue, renvoie
     rien ou ne fournit pas de colonnes xG exploitables.

NOTE : dans cet environnement, fbref.com répond 403 (blocage réseau) et FBref ne
sert plus xG/xA dans son HTML public (vérifié le 07/08/2026) : le chemin réel
d'exécution est donc le repli Understat. La provenance du dernier run est tracée
dans data/raw/stats_source.txt ("fbref" ou "understat").

Le xA est TOUJOURS issu d'Understat (FBref n'expose pas le xA équipe dans ses
matchlogs) : dans le chemin FBref, il est fusionné depuis le cache
advanced_stats.csv produit par les runs Understat précédents.

Le débit est limité à ~15-20 requêtes/min (intervalle 3,5 s) conformément à la
spécification.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import soccerdata as sd

from config import ADVANCED_CSV, LEAGUES, RAW_DIR, SOCCERDATA_CACHE, soccerdata_seasons
from util import RateLimiter, get_logger

log = get_logger("fbref")

XG_COLS = ["home_xg", "away_xg", "home_np_xg", "away_np_xg", "home_goals", "away_goals"]


def _stats_source_file() -> Path:
    return RAW_DIR / "stats_source.txt"


def _write_stats_source(source: str) -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    _stats_source_file().write_text(source, encoding="utf-8")


def _read_stats_source(default: str = "unknown") -> str:
    try:
        return _stats_source_file().read_text(encoding="utf-8").strip()
    except OSError:
        return default


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


def _normalize_fbref(tm: pd.DataFrame) -> pd.DataFrame:
    """Transforme les matchlogs FBref (par équipe) en lignes de match 1X1.

    Une ligne de matchlog FBref porte l'équipe concernée ('team'), son adversaire
    ('opponent'), le lieu ('venue' = Home/Away), le xG pour ('xg') et contre
    ('xga'). On pivote pour obtenir une ligne par match avec home_xg/away_xg.
    """
    df = tm.reset_index()
    df = df.rename(columns={c: str(c).lower().replace(" ", "_") for c in df.columns})
    need = {"date", "team", "xg", "xga", "opponent", "venue"}
    if not need.issubset(df.columns):
        return pd.DataFrame()
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.dropna(subset=["date", "team", "opponent", "xg", "xga"])
    if df.empty:
        return pd.DataFrame()

    rows = []
    for _, r in df.iterrows():
        if str(r["venue"]).strip().lower().startswith("home"):
            rows.append((r["date"], r["team"], r["opponent"], float(r["xg"]), float(r["xga"])))
        else:
            rows.append((r["date"], r["opponent"], r["team"], float(r["xga"]), float(r["xg"])))

    out = pd.DataFrame(rows, columns=["date", "home_team", "away_team", "home_xg", "away_xg"])
    out["date"] = pd.to_datetime(out["date"], errors="coerce").dt.floor("D")
    out["home_team"] = out["home_team"].fillna("").astype(str).str.strip()
    out["away_team"] = out["away_team"].fillna("").astype(str).str.strip()
    out = out.dropna(subset=["date", "home_team", "away_team", "home_xg", "away_xg"])
    return out.drop_duplicates(["date", "home_team", "away_team"])


def _try_fbref(names: list[str], seasons: list[int], limiter: RateLimiter,
               force: bool) -> pd.DataFrame | None:
    """Tente FBref ; renvoie le master xG (home/away) ou None si inexploitable."""
    limiter.wait()
    try:
        fb = sd.FBref(leagues=names, seasons=seasons, data_dir=SOCCERDATA_CACHE)
        tm = fb.read_team_match_stats(force_cache=force)
    except Exception as exc:  # noqa: BLE001
        log.warning("FBref : échec read_team_match_stats (%s)", exc)
        return None
    if tm is None or tm.empty:
        log.warning("FBref : aucun match log reçu")
        return None
    base = _normalize_fbref(tm)
    if base.empty or float(base["home_xg"].notna().mean()) < 0.5:
        log.warning("FBref : xG absents ou incomplets (%d matchs normalisés)", len(base))
        return None
    log.info("FBref : %d matchs xG normalisés", len(base))
    return base


def _load_cached_xa() -> pd.DataFrame | None:
    """xA équipe (date, home, away) depuis le cache advanced_stats.csv."""
    if not ADVANCED_CSV.exists():
        return None
    df = pd.read_csv(ADVANCED_CSV)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    keep = [c for c in ["date", "home_team", "away_team", "home_xa", "away_xa"] if c in df.columns]
    if len(keep) < 5:
        return None
    out = df[keep].dropna(subset=["date", "home_team", "away_team"])
    return out.drop_duplicates(["date", "home_team", "away_team"])


def _fetch_understat(names: list[str], seasons: list[int], limiter: RateLimiter,
                     force: bool) -> pd.DataFrame:
    """xG/xA (+ buts) par match via Understat (chemin historique)."""
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
    return base


def fetch(leagues=None, seasons=None, limiter: RateLimiter | None = None, force: bool = False) -> pd.DataFrame:
    """Télécharge les stats avancées (xG/xA) par match pour les ligues/saisons.

    FBref est tenté en premier ; en cas d'échec, repli automatique sur Understat.
    La provenance du run est tracée dans data/raw/stats_source.txt.
    """
    leagues = leagues or LEAGUES
    seasons = seasons if seasons is not None else soccerdata_seasons()
    limiter = limiter or RateLimiter()
    names = [cfg["name"] for cfg in leagues.values()]

    _patch_understat_rosters()

    base = _try_fbref(names, seasons, limiter, force)
    if base is not None and not base.empty:
        provider = "fbref"
        log.info("Stats avancées : xG via FBref (%d matchs)", len(base))
        xa = _load_cached_xa()
        if xa is not None and len(xa):
            base = base.merge(xa, on=["date", "home_team", "away_team"], how="left")
        for col in ("home_xa", "away_xa"):
            if col not in base.columns:
                base[col] = float("nan")
    else:
        base = _fetch_understat(names, seasons, limiter, force)
        provider = "understat"
        log.info("Stats avancées : repli Understat (%d matchs)", len(base))

    base["date"] = pd.to_datetime(base["date"], errors="coerce").dt.floor("D")
    base["home_team"] = base["home_team"].fillna("").astype(str).str.strip()
    base["away_team"] = base["away_team"].fillna("").astype(str).str.strip()
    base = base[base["date"].notna() & base["home_team"].ne("") & base["away_team"].ne("")]
    base = base.drop_duplicates(["date", "home_team", "away_team"])

    ADVANCED_CSV.parent.mkdir(parents=True, exist_ok=True)
    base.to_csv(ADVANCED_CSV, index=False)
    _write_stats_source(provider)
    log.info("Stats avancées (%s) : %d matchs", provider, len(base))
    return base
