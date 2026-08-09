"""Tests unitaires du backtest multi-marchés (fonctions pures de markets.py)."""
from __future__ import annotations

import numpy as np
import pytest

from markets import MARKETS, _brier, _metrics, simulate_value


def test_brier_binaire() -> None:
    y = np.array([1, 0])
    proba = np.array([[0.0, 1.0], [1.0, 0.0]])
    assert _brier(y, proba) == 0.0
    y2 = np.array([1, 1])
    p2 = np.array([[0.0, 1.0], [0.0, 1.0]])
    assert _brier(y2, p2) == 0.0


def test_brier_multiclasse() -> None:
    y = np.array([2, 1])
    proba = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0]])
    assert _brier(y, proba) == 0.0
    y_bad = np.array([0, 0])
    p_bad = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0]])
    assert _brier(y_bad, p_bad) == pytest.approx(2.0)


def test_metrics_parfait() -> None:
    y = np.array([0, 1, 2])
    proba = np.eye(3)
    m = _metrics(y, proba)
    assert m["accuracy"] == 1.0
    assert m["log_loss"] == pytest.approx(0.0)
    assert m["brier"] == 0.0


def test_simulate_value_pari_gagnant() -> None:
    proba = np.array([[0.1, 0.2, 0.7]])
    y_true = np.array([2])
    odds_open = np.array([[10.0, 8.0, 1.8]])
    odds_close = np.array([[10.0, 8.0, 2.0]])
    out = simulate_value(proba, y_true, odds_open, odds_close, edge_thr=0.04, min_prob=0.25)
    assert out["n_bets"] == 1
    assert out["hit_rate"] == 1.0
    assert out["returned"] == 2.0
    assert out["roi"] == 1.0


def test_simulate_value_aucune_edge() -> None:
    proba = np.array([[0.9, 0.05, 0.05]])
    y_true = np.array([2])
    odds_open = np.array([[1.1, 10.0, 10.0]])
    odds_close = np.array([[1.1, 10.0, 10.0]])
    out = simulate_value(proba, y_true, odds_open, odds_close, edge_thr=0.04, min_prob=0.25)
    assert out["n_bets"] == 0
    assert out["roi"] is None


def test_simulate_value_filtre_min_prob() -> None:
    proba = np.array([[0.3, 0.35, 0.35]])
    y_true = np.array([1])
    odds_open = np.array([[4.0, 2.8, 3.0]])
    odds_close = np.array([[4.0, 2.8, 3.0]])
    strict = simulate_value(proba, y_true, odds_open, odds_close, edge_thr=0.04, min_prob=0.5)
    assert strict["n_bets"] == 0
    lax = simulate_value(proba, y_true, odds_open, odds_close, edge_thr=0.04, min_prob=0.25)
    assert lax["n_bets"] == 1


def test_simulate_value_mise_perdante() -> None:
    proba = np.array([[0.1, 0.2, 0.7]])
    y_true = np.array([1])
    odds_open = np.array([[10.0, 8.0, 1.8]])
    odds_close = np.array([[10.0, 8.0, 2.0]])
    out = simulate_value(proba, y_true, odds_open, odds_close, edge_thr=0.04, min_prob=0.25)
    assert out["n_bets"] == 1
    assert out["hit_rate"] == 0.0
    assert out["returned"] == 0.0
    assert out["roi"] == -1.0


def test_markets_specifications_coherentes() -> None:
    assert set(MARKETS) == {"1x2", "ou25", "btts", "corners"}
    for market, spec in MARKETS.items():
        assert spec.kind in {"multiclass", "binary"}
        n_out = len(spec.labels)
        if spec.use_odds:
            assert len(spec.open_cols) == n_out == len(spec.close_cols)
            assert spec.outcome_map is not None and set(spec.outcome_map) == set(range(n_out))
        else:
            assert spec.open_cols == [] and spec.close_cols == []


def test_market_1x2_alignement() -> None:
    spec = MARKETS["1x2"]
    assert spec.labels == ["A", "D", "H"]
    assert spec.open_cols == ["odds_a_avg", "odds_d_avg", "odds_h_avg"]
    assert spec.close_cols == ["odds_a_close_avg", "odds_d_close_avg", "odds_h_close_avg"]


def test_market_corners_sans_cotes() -> None:
    spec = MARKETS["corners"]
    assert spec.kind == "binary"
    assert spec.feat_mode == "basic"
    assert spec.use_odds is False
