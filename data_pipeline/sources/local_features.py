"""local_features.py — Calculs locaux de features depuis historique de matchs.

Sources modèle (MODEL/COMPUTED dans le registry) — pas une source externe.

Calculs disponibles :
  - elo_local     : Elo avec K=20, home_adv=100, init=1500
  - form_glissante: forme récente (L3/L5/L10/L15) avec points/matchs
  - h2h_local     : historique H2H avec pondération décroissante
  - fatigue_index : jours de repos, matchs joués recently, score fatigue
"""
from __future__ import annotations

import math
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

from config import RAW_DIR
from util import get_logger

log = get_logger("local_features")

ELO_K = 20
ELO_HOME_ADV = 100
ELO_INIT = 1500
ELO_MIN_RD = 30

CACHE_DIR = RAW_DIR / "local_features"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def compute_expected_result(home_elo: float, away_elo: float,
                            home_adv: float = ELO_HOME_ADV) -> tuple[float, float, float]:
    exp = (home_elo + home_adv - away_elo) / 400.0
    p_home = 1.0 / (1.0 + math.pow(10, -exp))
    exp2 = (home_elo - away_elo) / 400.0
    p_draw = 1.0 / (1.0 + math.pow(10, -exp2)) * 0.28
    return max(0.0, min(1.0, p_home - p_draw * 0.5)), max(0.0, min(1.0, p_draw)), \
        max(0.0, min(1.0, 1.0 - p_home - p_draw))


def update_elo(home_elo: float, away_elo: float, home_score: int, away_score: int,
               home_adv: float = ELO_HOME_ADV, k: int = ELO_K) -> tuple[float, float]:
    p_home, p_draw, p_away = compute_expected_result(home_elo, away_elo, home_adv)
    if home_score > away_score:
        actual_home, actual_away = 1.0, 0.0
    elif home_score < away_score:
        actual_home, actual_away = 0.0, 1.0
    else:
        actual_home, actual_away = 0.5, 0.5
    new_home = home_elo + k * (actual_home - p_home)
    new_away = away_elo + k * (actual_away - p_away)
    return new_home, new_away


def compute_elo_from_history(df: pd.DataFrame, home_adv: float = ELO_HOME_ADV) -> pd.DataFrame:
    if df is None or df.empty or "date" not in df.columns:
        return pd.DataFrame()
    df = df.sort_values("date").reset_index(drop=True)
    elo_history = {}
    rows = []
    for _, r in df.iterrows():
        ht = r.get("home_team", "")
        at = r.get("away_team", "")
        if not ht or not at:
            continue
        home_elo = elo_history.get(ht, ELO_INIT)
        away_elo = elo_history.get(at, ELO_INIT)
        hs = int(r.get("home_score") or 0)
        as_ = int(r.get("away_score") or 0)
        new_home, new_away = update_elo(home_elo, away_elo, hs, as_, home_adv)
        elo_history[ht] = new_home
        elo_history[at] = new_away
        rows.append({
            "date": r.get("date"),
            "home_team": ht, "away_team": at,
            "home_elo": new_home, "away_elo": new_away,
            "elo_diff": new_home - new_away,
        })
    return pd.DataFrame(rows)


def compute_form(df: pd.DataFrame, windows: list[int] = None) -> pd.DataFrame:
    if df is None or df.empty or "date" not in df.columns:
        return pd.DataFrame()
    if windows is None:
        windows = [3, 5, 10, 15]
    df = df.sort_values("date").reset_index(drop=True)
    results = []
    for team in set(df["home_team"].dropna().unique()) | set(df["away_team"].dropna().unique()):
        team_home = df[df["home_team"] == team].copy()
        team_away = df[df["away_team"] == team].copy()
        all_matches = pd.concat([
            team_home.assign(
                date=lambda x: x["date"],
                goals_for=lambda x: x["home_score"],
                goals_against=lambda x: x["away_score"],
                is_home=True,
                result=lambda x: x.apply(
                    lambda r: "W" if r["home_score"] > r["away_score"]
                    else ("D" if r["home_score"] == r["away_score"] else "L"), axis=1
                )
            ),
            team_away.assign(
                date=lambda x: x["date"],
                goals_for=lambda x: x["away_score"],
                goals_against=lambda x: x["home_score"],
                is_home=False,
                result=lambda x: x.apply(
                    lambda r: "W" if r["away_score"] > r["home_score"]
                    else ("D" if r["away_score"] == r["home_score"] else "L"), axis=1
                )
            )
        ]).sort_values("date")
        all_matches["team"] = team
        all_matches["pts"] = all_matches["result"].map({"W": 3, "D": 1, "L": 0})
        for window in windows:
            all_matches[f"form_{window}"] = all_matches["pts"].rolling(window, min_periods=1).sum()
            all_matches[f"gfs_{window}"] = all_matches["goals_for"].rolling(window, min_periods=1).mean()
            all_matches[f"gca_{window}"] = all_matches["goals_against"].rolling(window, min_periods=1).mean()
            all_matches[f"mp_{window}"] = all_matches["pts"].rolling(window, min_periods=1).count()
        results.append(all_matches[["date", "team", "result", "pts",
                                    "goals_for", "goals_against", "is_home"] +
                                   [f"form_{w}" for w in windows] +
                                   [f"gfs_{w}" for w in windows] +
                                   [f"gca_{w}" for w in windows] +
                                   [f"mp_{w}" for w in windows]])
    return pd.concat(results, ignore_index=True) if results else pd.DataFrame()


def compute_h2h(df: pd.DataFrame, decay: float = 0.9) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame()
    df = df.sort_values("date").reset_index(drop=True)
    df["weight"] = decay ** (len(df) - df.index)
    h2h_rows = []
    for (ht, at), group in df.groupby(["home_team", "away_team"]):
        n = len(group)
        if n == 0:
            continue
        h_wins = int((group["home_score"] > group["away_score"]).sum())
        a_wins = int((group["away_score"] > group["home_score"]).sum())
        draws = int((group["home_score"] == group["away_score"]).sum())
        avg_gf = float(group["home_score"].mean())
        avg_ga = float(group["away_score"].mean())
        total_weight = group["weight"].sum()
        h2h_rows.append({
            "home_team": ht, "away_team": at,
            "h2h_n": n, "h2h_home_wins": h_wins, "h2h_away_wins": a_wins,
            "h2h_draws": draws, "h2h_goals_avg": avg_gf,
            "h2h_home_xg": avg_gf, "h2h_away_xg": avg_ga,
            "h2h_weight_sum": total_weight,
        })
    return pd.DataFrame(h2h_rows)


def compute_fatigue(df: pd.DataFrame, match_date: pd.Timestamp,
                    team: str, days_back: int = 14) -> dict:
    cutoff = match_date - pd.Timedelta(days=days_back)
    recent = df[
        ((df["home_team"] == team) | (df["away_team"] == team)) &
        (df["date"] < match_date) &
        (df["date"] >= cutoff)
    ]
    matches_14 = len(recent)
    last_match = recent["date"].max() if not recent.empty else None
    rest_days = (match_date - last_match).days if last_match is not None else 999
    return {
        f"rest_days_{team}": rest_days,
        f"matches_last_{days_back}d_{team}": matches_14,
        f"fatigue_score_{team}": max(0, min(10, 10 - rest_days / 3 + matches_14 * 0.5)),
    }


def enrich_match(row: pd.Series, elo_df: pd.DataFrame,
                  form_df: pd.DataFrame, h2h_df: pd.DataFrame) -> dict:
    ht = row.get("home_team", "")
    at = row.get("away_team", "")
    date = row.get("date")
    if isinstance(date, str):
        date = pd.to_datetime(date)
    out = dict(row)
    if not elo_df.empty:
        elo_row = elo_df[(elo_df["home_team"] == ht) & (elo_df["away_team"] == at)]
        if not elo_row.empty:
            last = elo_row.sort_values("date", ascending=False).iloc[0]
            out["home_elo"] = last.get("home_elo", ELO_INIT)
            out["away_elo"] = last.get("away_elo", ELO_INIT)
            out["elo_diff"] = last.get("elo_diff", 0)
    if not form_df.empty:
        for team, prefix in [(ht, "home"), (at, "away")]:
            tf = form_df[form_df["team"] == team]
            if not tf.empty:
                tf = tf.sort_values("date", ascending=False)
                for w in [3, 5, 10, 15]:
                    col = f"form_{w}"
                    if col in tf.columns:
                        out[f"{prefix}_form_{w}"] = float(tf[col].iloc[0]) if pd.notna(tf[col].iloc[0]) else 0.0
    if not h2h_df.empty:
        h2h_row = h2h_df[(h2h_df["home_team"] == ht) & (h2h_df["away_team"] == at)]
        if not h2h_row.empty:
            r = h2h_row.iloc[0]
            for col in ["h2h_n", "h2h_home_wins", "h2h_away_wins", "h2h_draws",
                        "h2h_goals_avg", "h2h_weight_sum"]:
                out[col] = r.get(col, 0)
    return out


def compute_local_features(master_df: pd.DataFrame,
                            extra_history: pd.DataFrame = None) -> dict:
    """Calcule Elo, forme, H2H depuis master + historique supplémentaire,
    puis enrichit chaque match du master avec ces features.

    Retourne un dict {match_index: {local_features}} prêt à être merge.
    """
    if master_df is None or master_df.empty:
        return {}
    combined = master_df[["home_team", "away_team", "date", "home_score", "away_score"]].copy()
    if extra_history is not None and not extra_history.empty:
        extra = extra_history[["home_team", "away_team", "date", "home_score", "away_score"]].copy()
        combined = pd.concat([combined, extra], ignore_index=True)
    combined["date"] = pd.to_datetime(combined["date"])
    combined = combined.sort_values("date").drop_duplicates(subset=["date", "home_team", "away_team"])
    elo_df = compute_elo_from_history(combined)
    form_df = compute_form(combined)
    h2h_df = compute_h2h(combined)
    engine = LocalFeaturesEngine(combined)
    engine.elo_df = elo_df
    engine.form_df = form_df
    engine.h2h_df = h2h_df
    results = {}
    for idx, row in master_df.iterrows():
        enriched = engine.enrich(row.to_dict())
        keep = ["home_elo", "away_elo", "elo_diff"]
        for w in [3, 5, 10, 15]:
            for prefix in ["home", "away"]:
                keep.append(f"{prefix}_form_{w}")
        for col in ["h2h_n", "h2h_home_wins", "h2h_away_wins", "h2h_draws",
                     "h2h_goals_avg", "h2h_weight_sum"]:
            keep.append(col)
        results[idx] = {k: v for k, v in enriched.items() if k in keep}
    return results


def merge_local_features_into_master(master_df: pd.DataFrame,
                                      local_features: dict) -> pd.DataFrame:
    """Merge un dict de local_features dans le master DataFrame."""
    df = master_df.copy()
    for idx, feats in local_features.items():
        if idx in df.index:
            for k, v in feats.items():
                df.at[idx, k] = v
    return df


class LocalFeaturesEngine:
    def __init__(self, df: pd.DataFrame = None):
        self.df = df
        self.elo_df: Optional[pd.DataFrame] = None
        self.form_df: Optional[pd.DataFrame] = None
        self.h2h_df: Optional[pd.DataFrame] = None

    def fit(self, df: pd.DataFrame = None):
        if df is not None:
            self.df = df
        if self.df is None or self.df.empty:
            return self
        self.elo_df = compute_elo_from_history(self.df)
        self.form_df = compute_form(self.df)
        self.h2h_df = compute_h2h(self.df)
        return self

    def enrich(self, match_row: dict) -> dict:
        if self.df is None or self.df.empty:
            return match_row
        row = pd.Series(match_row)
        return enrich_match(row, self.elo_df, self.form_df, self.h2h_df)
