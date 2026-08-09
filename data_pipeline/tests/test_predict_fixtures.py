"""Tests unitaires de predict_fixtures.py (date, forme as-of, cotes implicites)."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from predict_fixtures import _asof, implied_probs, parse_date


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
