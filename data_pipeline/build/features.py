"""Feature engineering : forme sur 5/10 derniers matchs, Elo diff, xG/xA roulants.

Les moyennes roulantes sont calculées sur la chronique complète de chaque équipe
(tous ses matchs, domicile + extérieur), STRICTEMENT antérieurs au match courant
(décalage de 1) pour éviter toute fuite de données.

Pour chaque match du master :
  - H_* = features de l'équipe à domicile (sa forme récente) ;
  - A_* = features de l'équipe à l'extérieur (sa forme récente).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from util import get_logger

log = get_logger("features")

WINDOWS = (5, 10)
BASE = ["league", "season", "date", "home_team", "away_team"]
# nom de feature -> expression dans la chronique d'une équipe
FEATURES = {
    "gf": ("fthg", "ftag"),
    "ga": ("ftag", "fthg"),
    "xg": ("home_xg", "away_xg"),
    "xga": ("away_xg", "home_xg"),
    "xa": ("home_xa", "away_xa"),
    "pts": None,
    "shots": ("hs", "away_shots"),
    "shots_a": ("away_shots", "hs"),
}

XG_COLS = ["home_xg", "away_xg", "home_xa", "away_xa"]


def _team_sequence(team: str, df: pd.DataFrame) -> pd.DataFrame:
    """Chronique d'une équipe avec ses moyennes roulantes pré-match."""
    mask = (df["home_team"] == team) | (df["away_team"] == team)
    s = df[mask].sort_values(["date", "season", "league"]).copy()
    if s.empty:
        return pd.DataFrame()
    for col in XG_COLS:
        if col not in s.columns:
            s[col] = np.nan
    is_home = s["home_team"] == team

    for feat, spec in FEATURES.items():
        if feat == "pts":
            s[f"_{feat}"] = np.where(
                is_home,
                np.select([s["ftr"] == "H", s["ftr"] == "D"], [3, 1], default=0),
                np.select([s["ftr"] == "A", s["ftr"] == "D"], [3, 1], default=0),
            )
        else:
            home_col, away_col = spec
            if home_col in s.columns and away_col in s.columns:
                s[f"_{feat}"] = np.where(is_home, s[home_col], s[away_col])

    out = s[BASE].copy()
    out["team"] = team
    for feat in FEATURES:
        src = f"_{feat}"
        if src not in s.columns:
            continue
        for w in WINDOWS:
            out[f"{feat}_L{w}"] = s[src].rolling(w, min_periods=1).mean().shift(1)
    return out


def compute_features(df: pd.DataFrame) -> pd.DataFrame:
    """Calcule les features roulantes par équipe sur le dataset aligné."""
    df = df.copy()
    teams = sorted(set(df["home_team"]) | set(df["away_team"]))
    seqs = [_team_sequence(team, df) for team in teams]
    seqs = [t for t in seqs if not t.empty]
    if not seqs:
        return df

    feat_names = [f"{f}_L{w}" for f in FEATURES for w in WINDOWS]
    team_feats = pd.concat(seqs, ignore_index=True)
    feat_names = [c for c in feat_names if c in team_feats.columns]
    team_feats = team_feats[["date", "team"] + feat_names].drop_duplicates(["date", "team"])

    home = team_feats.rename(columns={"team": "home_team", **{c: f"H_{c}" for c in feat_names}})
    df = df.merge(home, on=["date", "home_team"], how="left")
    away = team_feats.rename(columns={"team": "away_team", **{c: f"A_{c}" for c in feat_names}})
    df = df.merge(away, on=["date", "away_team"], how="left")

    # Features composites
    df["F_Elo_Diff"] = df.get("elo_home") - df.get("elo_away") if {"elo_home", "elo_away"}.issubset(df.columns) else np.nan
    if {"H_xg_L5", "A_xg_L5"}.issubset(df.columns):
        df["Total_xG_L5"] = df["H_xg_L5"] + df["A_xg_L5"]
    if {"H_pts_L5", "A_pts_L5"}.issubset(df.columns):
        df["Form_Diff_L5"] = df["H_pts_L5"] - df["A_pts_L5"]

    ordered = _order_columns(df)
    df = df[ordered].sort_values(["date", "league", "home_team", "away_team"]).reset_index(drop=True)
    log.info("Features : %d matchs, %d colonnes", len(df), len(ordered))
    return df


def _order_columns(df: pd.DataFrame) -> list[str]:
    first = [c for c in ["date", "league", "season", "home_team", "away_team"] if c in df.columns]
    rest = [c for c in df.columns if c not in first]
    return first + rest
