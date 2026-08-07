"""Tests du rapport qualité (watchdog) : couverture + provenance."""
from __future__ import annotations

import json

import pandas as pd

from build import quality


def _master_df() -> pd.DataFrame:
    return pd.DataFrame({
        "date": ["2024-01-01", "2024-01-02"],
        "league": ["E0", "E0"],
        "season": ["2425", "2425"],
        "home_team": ["Arsenal", "Chelsea"],
        "away_team": ["Chelsea", "Arsenal"],
        "odds_h_avg": [1.5, 2.0],
        "odds_d_avg": [4.0, 3.5],
        "odds_a_avg": [6.0, 3.0],
        "home_xg": [1.2, None],
        "away_xg": [0.8, 1.1],
        "elo_home": [1500.0, 1500.0],
        "elo_away": [1400.0, 1400.0],
        "H_pts_L5": [2.0, 2.0],
        "A_pts_L5": [1.0, 1.0],
        "elo_source": ["local", "local"],
    })


def test_report_couverture_et_provenance(tmp_path) -> None:
    master = tmp_path / "master.csv"
    _master_df().to_csv(master, index=False)
    state = tmp_path / "state.json"
    state.write_text(json.dumps({"elo_source": "local", "last_build": "2024-01-03T00:00:00Z"}))

    rep = quality.report(master, state)

    assert rep["summary"]["rows"] == 2
    assert rep["summary"]["first_match"] == "2024-01-01"
    assert rep["summary"]["last_match"] == "2024-01-02"
    assert rep["summary"]["elo_source"] == "local"
    by_src = {c["source"]: c for c in rep["summary"]["checks"]}
    assert by_src["odds"]["coverage_pct"] == 100.0
    assert by_src["xG"]["coverage_pct"] == 75.0  # 3 valeurs sur 4
    assert by_src["Elo"]["coverage_pct"] == 100.0
    assert by_src["elo_provenance"]["distribution"] == {"local": 2}


def test_report_master_absent(tmp_path) -> None:
    rep = quality.report(tmp_path / "absent.csv", tmp_path / "state.json")
    assert "error" in rep["summary"]


def test_report_sans_colonne_elo_source(tmp_path) -> None:
    master = tmp_path / "master.csv"
    df = _master_df().drop(columns=["elo_source"])
    df.to_csv(master, index=False)
    state = tmp_path / "state.json"
    state.write_text(json.dumps({}))

    rep = quality.report(master, state)
    assert all(c["source"] != "elo_provenance" for c in rep["summary"]["checks"])
