"""Tests du Data Quality Score par match (audit P0 Phase 2)."""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data_quality import compute_dq, summarize  # noqa: E402


def _base_row(**over):
    row = {
        "date": "2025-08-15",
        "league": "E0",
        "season": 2526,
        "home_team": "Arsenal",
        "away_team": "Chelsea",
        "fthg": 2,
        "ftag": 1,
        "ftr": "H",
        "odds_h_avg": 1.8,
        "odds_d_avg": 3.6,
        "odds_a_avg": 4.5,
        "odds_h_close_avg": 1.75,
        "odds_d_close_avg": 3.7,
        "odds_a_close_avg": 4.6,
        "odds_o25_avg": 1.9,
        "odds_u25_avg": 1.95,
        "elo_home": 1750.0,
        "elo_away": 1680.0,
        "home_xg": 1.7,
        "away_xg": 0.9,
        "home_xa": 1.0,
        "away_xa": 1.6,
    }
    row.update(over)
    return pd.DataFrame([row])


def test_ligne_saine_score_eleve():
    dq = compute_dq(_base_row(H_pts_L5=9, A_pts_L5=6))
    s = summarize(dq)
    assert s["incoherent"] == 0
    assert dq["dq_total"].iloc[0] >= 0.85


def test_manques_font_baisser_le_score():
    full = compute_dq(_base_row())
    poor = compute_dq(
        _base_row().assign(home_xg=[None], away_xg=[None], home_xa=[None], away_xa=[None])
    )
    assert poor["dq_total"].iloc[0] < full["dq_total"].iloc[0]


def test_scores_negatifs_incoherents():
    dq = compute_dq(_base_row(fthg=-1))
    assert dq["dq_coherence"].iloc[0] == 0
    assert dq["dq_total"].iloc[0] == 0


def test_ftr_incoherent_avec_score():
    dq = compute_dq(_base_row(fthg=2, ftag=0, ftr="A"))
    assert dq["dq_coherence"].iloc[0] == 0


def test_elo_hors_plage_incoherent():
    dq = compute_dq(_base_row(elo_home=50.0))
    assert dq["dq_coherence"].iloc[0] == 0


def test_bornes_et_colonnes():
    dq = compute_dq(pd.concat([_base_row(), _base_row(home_team="X")], ignore_index=True))
    assert (dq["dq_total"] >= 0).all() and (dq["dq_total"] <= 1).all()
    expected = {
        "dq_identity", "dq_result", "dq_odds_1x2", "dq_odds_close_1x2",
        "dq_odds_ou25", "dq_elo", "dq_xg", "dq_form", "dq_coherence", "dq_total",
    }
    assert expected.issubset(set(dq.columns))
