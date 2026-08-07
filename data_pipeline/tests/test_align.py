"""Tests de la fusion des sources et du lookup Elo as-of (anti-fuite)."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from build.align import align


def _fd(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"])
    df["league"] = df.get("league", "E0")
    df["season"] = df.get("season", "2425")
    return df


def _elo(rows: list[tuple[str, str, float]]) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=["from", "team_raw", "elo"])
    df["from"] = pd.to_datetime(df["from"])
    return df


def test_elo_asof_strictement_anterieur() -> None:
    fd = _fd([
        {"date": "2024-01-10", "home_team": "Arsenal", "away_team": "Chelsea"},
    ])
    hist = _elo([
        ("2024-01-01", "Arsenal", 1500.0),
        ("2024-01-15", "Arsenal", 1600.0),
        ("2024-01-01", "Chelsea", 1400.0),
    ])
    df = align(fd, hist, None)
    # Le match du 10/01 doit prendre l'Elo du 01/01 (1500), PAS celui du 15/01.
    assert df.loc[0, "elo_home"] == 1500.0
    assert df.loc[0, "elo_away"] == 1400.0


def test_elo_asof_same_day_inclus() -> None:
    fd = _fd([
        {"date": "2024-01-15", "home_team": "Arsenal", "away_team": "Chelsea"},
    ])
    hist = _elo([
        ("2024-01-01", "Arsenal", 1500.0),
        ("2024-01-15", "Arsenal", 1610.0),
        ("2024-01-01", "Chelsea", 1400.0),
    ])
    df = align(fd, hist, None)
    assert df.loc[0, "elo_home"] == 1610.0


def test_elo_absent_pour_team_inconnue() -> None:
    fd = _fd([
        {"date": "2024-01-10", "home_team": "Unknown A", "away_team": "Unknown B"},
    ])
    # Hist non vide (sinon la colonne elo_* n'est pas créée) : équipe inconnue -> NaN.
    hist = _elo([
        ("2024-01-01", "Liverpool", 1800.0),
    ])
    df = align(fd, hist, None)
    assert np.isnan(df.loc[0, "elo_home"])
    assert np.isnan(df.loc[0, "elo_away"])


def test_deduplication_sur_cle_match() -> None:
    fd = _fd([
        {"date": "2024-01-10", "home_team": "Arsenal", "away_team": "Chelsea"},
        {"date": "2024-01-10", "home_team": "Arsenal", "away_team": "Chelsea"},
        {"date": "2024-01-12", "home_team": "Arsenal", "away_team": "Chelsea"},
    ])
    df = align(fd, _elo([]), None)
    assert len(df) == 2


def test_join_advanced_stats_par_equipes() -> None:
    fd = _fd([
        {"date": "2024-01-10", "home_team": "Arsenal", "away_team": "Chelsea"},
    ])
    adv = pd.DataFrame([
        {"date": pd.Timestamp("2024-01-10"), "home_team": "Arsenal",
         "away_team": "Chelsea", "home_xg": 1.7, "away_xg": 0.9},
    ])
    df = align(fd, _elo([]), adv)
    assert df.loc[0, "home_xg"] == 1.7
    assert df.loc[0, "away_xg"] == 0.9


def test_join_sans_correspondance_donne_nan() -> None:
    fd = _fd([
        {"date": "2024-01-10", "home_team": "Arsenal", "away_team": "Chelsea"},
    ])
    adv = pd.DataFrame([
        {"date": pd.Timestamp("2024-01-10"), "home_team": "Liverpool",
         "away_team": "Chelsea", "home_xg": 1.7, "away_xg": 0.9},
    ])
    df = align(fd, _elo([]), adv)
    assert np.isnan(df.loc[0, "home_xg"])


def test_elo_source_provenance_et_defaut() -> None:
    fd = _fd([
        {"date": "2024-01-10", "home_team": "Arsenal", "away_team": "Chelsea"},
    ])
    hist = _elo([
        ("2024-01-01", "Arsenal", 1500.0),
        ("2024-01-01", "Chelsea", 1400.0),
    ])
    df = align(fd, hist, None, elo_source="cache")
    assert df.loc[0, "elo_source"] == "cache"

    df2 = align(fd, hist, None)
    assert df2.loc[0, "elo_source"] == "local"


def test_elo_source_absent_sans_historique() -> None:
    fd = _fd([
        {"date": "2024-01-10", "home_team": "Arsenal", "away_team": "Chelsea"},
    ])
    df = align(fd, None, None)
    assert "elo_source" not in df.columns
