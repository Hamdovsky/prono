"""Fusion des sources sur (date, home_team, away_team) après mappage des noms."""
from __future__ import annotations

import numpy as np
import pandas as pd

from team_mapping import TeamMapper
from util import get_logger

log = get_logger("align")

MATCH_KEY = ["league", "season", "date", "home_team", "away_team"]


def _attach_elo(df: pd.DataFrame, elo_hist: pd.DataFrame, team_col: str, mapper: TeamMapper) -> pd.DataFrame:
    """Attache le rating Elo pré-match (lookup as-of par équipe et date)."""
    hist = elo_hist.copy()
    hist["team_canonical"] = hist["team_raw"].map(mapper.map)
    grouped: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for team, arr in hist.groupby("team_canonical"):
        grouped[team] = (
            arr["from"].astype("int64").to_numpy() // 10**9,
            arr["elo"].astype(float).to_numpy(),
        )
    dates_s = df["date"].astype("int64").to_numpy() // 10**9

    def lookup(team: str, ts: int) -> float:
        entry = grouped.get(team)
        if entry is None or len(entry[0]) == 0:
            return np.nan
        idx = int(np.searchsorted(entry[0], ts, side="right") - 1)
        return float(entry[1][idx]) if idx >= 0 else np.nan

    out_col = "elo_home" if team_col == "home_team" else "elo_away"
    df[out_col] = [lookup(t, d) for t, d in zip(df[team_col], dates_s)]
    return df


def align(fd_df: pd.DataFrame, elo_hist: pd.DataFrame | None, adv_df: pd.DataFrame | None,
          mapper: TeamMapper | None = None) -> pd.DataFrame:
    """Fusionne Football-Data (base), Elo ClubElo et stats avancées par match."""
    mapper = mapper or TeamMapper()
    df = fd_df.copy()
    df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.floor("D")
    df["home_team"] = df["home_team"].map(mapper.map)
    df["away_team"] = df["away_team"].map(mapper.map)
    df = df.sort_values("date").drop_duplicates(MATCH_KEY)

    if elo_hist is not None and len(elo_hist):
        df = _attach_elo(df, elo_hist, "home_team", mapper)
        df = _attach_elo(df, elo_hist, "away_team", mapper)

    if adv_df is not None and len(adv_df):
        adv = adv_df.copy()
        adv["date"] = pd.to_datetime(adv["date"], errors="coerce").dt.floor("D")
        adv["home_team"] = adv["home_team"].map(mapper.map)
        adv["away_team"] = adv["away_team"].map(mapper.map)
        adv = adv.drop_duplicates(["date", "home_team", "away_team"])
        extra = [c for c in ["home_xg", "away_xg", "home_xa", "away_xa", "home_goals", "away_goals"] if c in adv.columns]
        df = df.merge(adv[["date", "home_team", "away_team"] + extra],
                      on=["date", "home_team", "away_team"], how="left")

    elo_cov = df["elo_home"].notna().mean() if "elo_home" in df.columns else 0.0
    xg_cov = df["home_xg"].notna().mean() if "home_xg" in df.columns else 0.0
    log.info("Alignement : %d matchs — Elo couvert %.1f%%, xG couvert %.1f%%",
             len(df), 100 * elo_cov, 100 * xg_cov)
    return df
