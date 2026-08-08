"""Tests du feature engineering : moyennes roulantes SANS fuite temporelle."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from build.features import compute_features


def _master(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"])
    for col in ("league", "season"):
        df[col] = df.get(col, "E0" if col == "league" else "2425")
    return df


def test_rolling_feature_utilise_uniquement_les_matchs_anterieurs() -> None:
    # T marque 2 buts à domicile (match 1) puis 2 buts à l'extérieur (match 2),
    # puis 1 but à domicile (match 3). La feature gf_L5 de T au match 3 ne doit
    # PAS inclure le but du match 3 (fuite) : moyenne des matchs 1 et 2 = 2.0.
    df = _master([
        {"date": "2024-01-01", "home_team": "T", "away_team": "X",
         "fthg": 2, "ftag": 0, "ftr": "H"},
        {"date": "2024-01-08", "home_team": "Z", "away_team": "T",
         "fthg": 1, "ftag": 2, "ftr": "A"},
        {"date": "2024-01-15", "home_team": "T", "away_team": "W",
         "fthg": 1, "ftag": 1, "ftr": "D"},
    ])
    out = compute_features(df)
    row3 = out[out["date"] == pd.Timestamp("2024-01-15")].iloc[0]
    assert row3["H_gf_L5"] == pytest.approx(2.0)


def test_premiere_sortie_dune_equipe_est_nan() -> None:
    df = _master([
        {"date": "2024-01-01", "home_team": "T", "away_team": "X",
         "fthg": 1, "ftag": 1, "ftr": "D"},
    ])
    out = compute_features(df)
    assert np.isnan(out.loc[0, "H_gf_L5"])
    assert np.isnan(out.loc[0, "H_pts_L5"])


def test_pts_calcules_selon_domicile_exterieur() -> None:
    df = _master([
        {"date": "2024-01-01", "home_team": "T", "away_team": "X",
         "fthg": 2, "ftag": 0, "ftr": "H"},
        {"date": "2024-01-08", "home_team": "T", "away_team": "Y",
         "fthg": 1, "ftag": 1, "ftr": "D"},
        {"date": "2024-01-15", "home_team": "Z", "away_team": "T",
         "fthg": 0, "ftag": 1, "ftr": "A"},
        {"date": "2024-01-22", "home_team": "T", "away_team": "W",
         "fthg": 0, "ftag": 0, "ftr": "D"},
    ])
    out = compute_features(df)
    row4 = out[out["date"] == pd.Timestamp("2024-01-22")].iloc[0]
    # T : victoire (3) + nul domicile (1) + victoire extérieur (3) = 7 pts sur 3 matchs
    assert row4["H_pts_L5"] == pytest.approx(7.0 / 3.0)


def test_work_sans_elo_ni_xg() -> None:
    df = _master([
        {"date": "2024-01-01", "home_team": "T", "away_team": "X",
         "fthg": 1, "ftag": 1, "ftr": "D"},
    ])
    out = compute_features(df)
    assert "F_Elo_Diff" not in out.columns or np.isnan(out["F_Elo_Diff"].iloc[0])


def test_probabilites_cotes_fermees_normalisees() -> None:
    df = _master([
        {"date": "2024-01-01", "home_team": "T", "away_team": "X",
         "fthg": 1, "ftag": 1, "ftr": "D",
         "odds_h_avg": 2.0, "odds_d_avg": 3.4, "odds_a_avg": 3.8,
         "odds_h_close_avg": 1.9, "odds_d_close_avg": 3.5, "odds_a_close_avg": 4.0,
         "odds_o25_close_avg": 1.7, "odds_o25_avg": 1.65},
    ])
    out = compute_features(df)
    row = out.iloc[0]
    # probas fermées normalisées (somme = 1)
    s = row["P1_close_avg"] + row["PX_close_avg"] + row["P2_close_avg"]
    assert s == pytest.approx(1.0)
    # le favori domicile a la proba la plus haute
    assert row["P1_close_avg"] > row["PX_close_avg"] > row["P2_close_avg"]
    # mouvement de marché : ouverture -> fermeture
    assert row["F_OddsH_Close_Diff"] == pytest.approx(-0.1)  # 1.9 - 2.0
    assert row["F_O25_Close_Diff"] == pytest.approx(0.05)  # 1.7 - 1.65


def test_pas_de_colonnes_cotes_renvoie_nan() -> None:
    df = _master([
        {"date": "2024-01-01", "home_team": "T", "away_team": "X",
         "fthg": 1, "ftag": 1, "ftr": "D"},
    ])
    out = compute_features(df)
    for col in ("P1_close_avg", "P1_open_avg", "F_OddsH_Close_Diff"):
        assert col not in out.columns or np.isnan(out[col].iloc[0])
