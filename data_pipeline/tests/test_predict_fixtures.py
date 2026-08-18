"""Tests unitaires de predict_fixtures.py (date, forme as-of, cotes implicites)."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from predict_fixtures import (
    _asof,
    implied_probs,
    load_fixtures_auto,
    load_football_data_odds,
    merge_odds,
    parse_date,
)


def test_parse_date_iso() -> None:
    assert parse_date("2026-08-15") == pd.Timestamp("2026-08-15")


def test_parse_date_jour_mois_an() -> None:
    assert parse_date("15/08/2026") == pd.Timestamp("2026-08-15")


def test_parse_date_invalide() -> None:
    assert parse_date("pas-une-date") is None
    assert pd.isna(parse_date(None))


def _grouped() -> dict:
    dates = np.array([pd.Timestamp("2026-08-01").value, pd.Timestamp("2026-08-05").value])
    values = np.array([[1.0, 2.0], [3.0, 4.0]])
    return {"Arsenal": (dates, values)}


def test_asof_avant_tout_historique() -> None:
    ts = pd.Timestamp("2026-07-30").value
    assert _asof(_grouped(), "Arsenal", ts) is None


def test_asof_dernier_match_avant_date() -> None:
    grouped = _grouped()
    ts = pd.Timestamp("2026-08-03").value
    assert np.array_equal(_asof(grouped, "Arsenal", ts), np.array([1.0, 2.0]))


def test_asof_date_egale_au_dernier_match() -> None:
    grouped = _grouped()
    ts = pd.Timestamp("2026-08-05").value
    assert np.array_equal(_asof(grouped, "Arsenal", ts), np.array([3.0, 4.0]))


def test_asof_equipe_inconnue() -> None:
    ts = pd.Timestamp("2026-08-03").value
    assert _asof(_grouped(), "Inexistant FC", ts) is None


def test_implied_probs_normalisees() -> None:
    odds = pd.Series({"odds_h_avg": 2.0, "odds_d_avg": 3.0, "odds_a_avg": 6.0})
    out = implied_probs(odds)
    assert set(out) == {"implied_h", "implied_d", "implied_a"}
    assert sum(out.values()) == pytest.approx(1.0)
    assert out["implied_h"] == pytest.approx(0.5, abs=1e-3)
    assert out["implied_a"] == pytest.approx(1 / 6, abs=1e-3)


def test_load_fixtures_auto_filtre_affiches_futures(monkeypatch) -> None:
    import predict_fixtures as pf

    def _fake_fetch_schedule(leagues=None, seasons=None, limiter=None, force=False):
        return pd.DataFrame({
            "date": pd.to_datetime(["2026-08-21", "2026-08-15"]),
            "home_team": ["Arsenal", "Chelsea"],
            "away_team": ["Coventry City", "Man City"],
            "home_score": [float("nan"), 2],
            "away_score": [float("nan"), 1],
        })

    monkeypatch.setattr(pf, "fetch_schedule", _fake_fetch_schedule)
    monkeypatch.setattr(pf, "LEAGUES", {"E0": {"name": "ENG-Premier League"}})

    out = load_fixtures_auto()
    assert len(out) == 1
    assert out.iloc[0]["home_team"] == "Arsenal"
    assert out.iloc[0]["league"] == "ENG-Premier League"


def test_load_football_data_odds_absent(tmp_path) -> None:
    out = load_football_data_odds(tmp_path / "inexistant.csv")
    assert out.empty


def test_load_football_data_odds_filtre(tmp_path) -> None:
    p = tmp_path / "fixtures.csv"
    p.write_text(
        "date,home_team,away_team,odds_h_avg,odds_d_avg,odds_a_avg\n"
        "19/08/2026,Atl. Madrid,Malaga,1.3,5.25,10.19\n"
        "pas-une-date,Team A,Team B,2.0,3.0,4.0\n",
        encoding="utf-8",
    )
    out = load_football_data_odds(p)
    assert len(out) == 1
    assert out.iloc[0]["home_team"] == "Atl. Madrid"
    assert out.iloc[0]["odds_h_avg"] == pytest.approx(1.3)


def test_merge_odds_alignement_par_equipe(tmp_path, monkeypatch) -> None:
    import predict_fixtures as pf

    p = tmp_path / "fixtures.csv"
    p.write_text(
        "date,home_team,away_team,odds_h_avg,odds_d_avg,odds_a_avg\n"
        "2026-08-21,Arsenal,Coventry City,1.5,4.0,6.0\n",
        encoding="utf-8",
    )
    odds = load_football_data_odds(p)
    fixtures = pd.DataFrame({
        "date": pd.to_datetime(["2026-08-21", "2026-08-22"]),
        "home_team": ["Arsenal", "Chelsea"],
        "away_team": ["Coventry City", "Man City"],
        "league": ["ENG-Premier League", "ENG-Premier League"],
    })
    merged = merge_odds(fixtures, odds)

    # Affiche couverte : cotes réelles.
    assert merged.loc[0, "odds_h_avg"] == pytest.approx(1.5)
    # Affiche non couverte : NaN conservé.
    assert pd.isna(merged.loc[1, "odds_h_avg"])
    assert pd.isna(merged.loc[1, "odds_a_avg"])


def test_merge_odds_vide_garde_nan(tmp_path) -> None:
    fixtures = pd.DataFrame({
        "date": pd.to_datetime(["2026-08-21"]),
        "home_team": ["Arsenal"],
        "away_team": ["Coventry City"],
        "league": ["ENG-Premier League"],
    })
    merged = merge_odds(fixtures, pd.DataFrame())
    assert pd.isna(merged.loc[0, "odds_h_avg"])
    assert "odds_d_avg" in merged.columns
