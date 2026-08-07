"""Préparation des données ML à partir du master dataset.

Définit la cible (1X2), les features pré-informatives (sans fuite) et les
métadonnées (date/ligue/saison/équipes) pour l'entraînement et le backtest.

Deux jeux de features :
  - "basic" : Elo + forme buts/points/tirs (utilisable sur 100 % des matchs) ;
  - "full"  : basic + xG/xGA/xA roulants (nécessite les stats avancées).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

TARGET_MAP = {"H": 2, "D": 1, "A": 0}

ELO_FEATS = ["elo_home", "elo_away", "F_Elo_Diff"]
BASIC_ROLLING = [
    "gf", "ga", "pts", "shots", "shots_a",
]
ADV_ROLLING = ["xg", "xga", "xa"]

FEATURES_BASIC = ELO_FEATS + [f"{s}_{m}_L{w}" for s in ("H", "A") for m in BASIC_ROLLING for w in (5, 10)]
FEATURES_FULL = FEATURES_BASIC + [f"{s}_{m}_L{w}" for s in ("H", "A") for m in ADV_ROLLING for w in (5, 10)] + [
    "Total_xG_L5",
    "Form_Diff_L5",
]

# Probabilités implicites dénormalisées des cotes moyennes (dispo pré-match)
ODDS_FEATURES = ["implied_h", "implied_d", "implied_a"]

LEAK_COLUMNS = {"fthg", "ftag", "hthg", "htag", "hs", "away_shots", "hst", "ast",
                "home_goals", "away_goals", "ftr", "htr", "hr", "ar",
                "odds_h_b365", "odds_d_b365", "odds_a_b365",
                "odds_h_ps", "odds_d_ps", "odds_a_ps",
                "odds_h_avg", "odds_d_avg", "odds_a_avg",
                "odds_h_max", "odds_d_max", "odds_a_max",
                "home_xg", "away_xg", "home_xa", "away_xa"}


def prepare(df: pd.DataFrame, mode: str = "full", dropna: bool = True, use_odds: bool = False):
    """Prépare X (features), y (cible) et les métadonnées pour l'apprentissage.

    Parameters
    ----------
    df : pd.DataFrame
        Master dataset (master_dataset.csv).
    mode : str
        "full" (avec xG) ou "basic" (sans xG).
    dropna : bool
        Retirer les lignes dont une feature est manquante (début de saison,
        matchs sans xG, ...).
    use_odds : bool
        Ajouter les probabilités implicites dérivées des cotes moyennes
        (disponibles pré-match, donc sans fuite).

    Returns
    -------
    (X, y, meta) : (DataFrame, Series, DataFrame)
    """
    df = df.copy()
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    feats = FEATURES_FULL if mode == "full" else FEATURES_BASIC
    if use_odds:
        implied = 1.0 / df[["odds_h_avg", "odds_d_avg", "odds_a_avg"]].astype(float)
        implied_sum = implied.sum(axis=1)
        for col, key in zip(ODDS_FEATURES, ["odds_h_avg", "odds_d_avg", "odds_a_avg"]):
            df[col] = (1.0 / df[key].astype(float)) / implied_sum
        feats = feats + ODDS_FEATURES
    available = [c for c in feats if c in df.columns]
    if len(available) < len(feats):
        missing = sorted(set(feats) - set(available))
        print(f"[ml_mapper] Features manquantes (mode={mode}) : {missing}")
        if mode == "full" and not df["home_xg"].notna().any():
            print("[ml_mapper] Aucune donnée xG — bascule automatique en mode 'basic'")
            return prepare(df, "basic", dropna, use_odds)

    meta = df[["date", "league", "season", "home_team", "away_team"]].copy()
    X = df[available].copy()
    X = X.apply(pd.to_numeric, errors="coerce")
    y = df["ftr"].map(TARGET_MAP).astype(int)

    valid = X.notna().all(axis=1) if dropna else pd.Series(True, index=X.index)
    valid &= y.notna() & df["date"].notna()
    return X[valid], y[valid], meta[valid]


def feature_names(mode: str = "full", use_odds: bool = False) -> list[str]:
    feats = FEATURES_FULL if mode == "full" else FEATURES_BASIC
    return feats + ODDS_FEATURES if use_odds else feats
