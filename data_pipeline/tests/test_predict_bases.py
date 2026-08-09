"""Tests unitaires de predict_bases.py (émission des bases et alignement des cotes)."""
from __future__ import annotations

import numpy as np
import pandas as pd

from predict_bases import ODDS_BY_PICK, THRESHOLDS, _odds_lookup, emit_bases
from team_mapping import TeamMapper


def _fixtures() -> pd.DataFrame:
    df = pd.DataFrame([
        {"date": "2026-08-15", "league": "E0", "home_team": "Arsenal", "away_team": "Chelsea",
         "odds_h_avg": 1.8, "odds_d_avg": 3.5, "odds_a_avg": 4.5},
        {"date": "2026-08-16", "league": "E0", "home_team": "Man City", "away_team": "Liverpool",
         "odds_h_avg": 2.1, "odds_d_avg": 3.4, "odds_a_avg": 3.3},
    ])
    df["date"] = pd.to_datetime(df["date"])
    return df


def _meta() -> pd.DataFrame:
    mapper = TeamMapper()
    return pd.DataFrame([
        {"date": pd.Timestamp("2026-08-15"), "league": "ENG-Premier League",
         "home_team": mapper.map("Arsenal"), "away_team": mapper.map("Chelsea")},
        {"date": pd.Timestamp("2026-08-16"), "league": "ENG-Premier League",
         "home_team": mapper.map("Man City"), "away_team": mapper.map("Liverpool")},
    ])


def test_odds_lookup_cle_canonique() -> None:
    lookup = _odds_lookup(_fixtures())
    assert len(lookup) == 2
    mapper = TeamMapper()
    key = (pd.Timestamp("2026-08-15").normalize(),
           mapper.map("Arsenal"), mapper.map("Chelsea"))
    assert lookup[key]["odds_h_avg"] == 1.8


def test_emit_bases_1x2_avec_value() -> None:
    lookup = _odds_lookup(_fixtures())
    proba = np.array([[0.1, 0.2, 0.7], [0.3, 0.5, 0.2]])
    out = emit_bases(_meta(), proba, "1x2", lookup)
    assert len(out) == 1
    row = out.iloc[0]
    assert row["pick"] == "H"
    assert row["prob"] == 0.7
    assert row["odds"] == 1.8
    assert round(row["value"], 2) == 0.26


def test_emit_bases_sans_cotes_pas_de_value() -> None:
    proba = np.array([[0.1, 0.2, 0.7], [0.3, 0.5, 0.2]])
    out = emit_bases(_meta(), proba, "1x2", {})
    assert len(out) == 1
    assert "odds" not in out.columns and "value" not in out.columns


def test_emit_bases_seuil_binaire_corners() -> None:
    proba = np.array([[0.7, 0.3], [0.59, 0.41]])
    out = emit_bases(_meta(), proba, "corners", {})
    assert len(out) == 1
    assert out.iloc[0]["market"] == "Corners 10.5"
    assert out.iloc[0]["pick"] == "under"


def test_emit_bases_cotes_alignees_sur_mapping() -> None:
    meta = _meta()
    meta.loc[1, "home_team"] = "Équipe Sans Historique"
    proba = np.array([[0.1, 0.2, 0.7], [0.2, 0.1, 0.7]])
    lookup = _odds_lookup(_fixtures())
    out = emit_bases(meta, proba, "1x2", lookup)
    assert len(out) == 2
    row0 = out[out["home_team"] == meta.iloc[0]["home_team"]].iloc[0]
    assert row0["odds"] == 1.8
    assert round(row0["value"], 2) == 0.26
    row1 = out[out["home_team"] == "Équipe Sans Historique"].iloc[0]
    assert pd.isna(row1["odds"]) and pd.isna(row1["value"])


def test_seuils_et_cotes_par_marche() -> None:
    assert THRESHOLDS["1x2"] == 0.55
    assert THRESHOLDS["corners"] == 0.60
    assert ODDS_BY_PICK["1x2"]["H"] == "odds_h_avg"
    assert ODDS_BY_PICK["ou25"]["over"] == "odds_o25_avg"
    assert ODDS_BY_PICK["corners"] == {}
