"""Tests unitaires du Veto Guard dans bet_backtest.py (miroir pipeline)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from bet_backtest import (  # noqa: E402
    GUARD_MAX_HIT, GUARD_MIN_PROB, GUARD_MIN_SAMPLES,
    bracket_hitrate, evaluate, select_argmax,
)

_DATE = __import__("datetime").datetime(2026, 8, 1)

ROWS = [
    {"date": _DATE, "y": 0, "ph": 0.20, "pd_": 0.10, "pa": 0.70, "oh": 3.0, "od": 5.0, "oa": 1.5},
    {"date": _DATE, "y": 0, "ph": 0.20, "pd_": 0.10, "pa": 0.75, "oh": 3.0, "od": 5.0, "oa": 1.4},
    {"date": _DATE, "y": 1, "ph": 0.75, "pd_": 0.15, "pa": 0.10, "oh": 1.4, "od": 5.0, "oa": 7.0},
]


def test_constantes_guard() -> None:
    assert GUARD_MIN_PROB == 0.70
    assert GUARD_MAX_HIT == 0.60
    assert GUARD_MIN_SAMPLES >= 1


def test_bracket_hitrate() -> None:
    brackets = bracket_hitrate(ROWS)
    assert "70-80" in brackets
    # 3 selections >= 0.70 : pa(2x), ph(1x) ; gagnants = 2 (pa y=0 sur rows 1-2)
    info = brackets["70-80"]
    assert info["n"] == 3
    assert info["hit"] == 2 / 3


def test_evaluate_guard_skip_faible_bracket() -> None:
    brackets = {"70-80": {"n": 20, "hit": 0.30}}
    bets_plain = evaluate(ROWS, select_argmax)
    bets_guard = evaluate(ROWS, select_argmax, guard=True, brackets=brackets)
    assert len(bets_plain) == 3
    assert len(bets_guard) == 0


def test_evaluate_guard_garde_bracket_fort() -> None:
    brackets = {"70-80": {"n": 20, "hit": 0.80}}
    bets = evaluate(ROWS, select_argmax, guard=True, brackets=brackets)
    assert len(bets) == 3


def test_evaluate_guard_ignore_probs_basses() -> None:
    rows_low = [{"date": _DATE, "y": 0, "ph": 0.40, "pd_": 0.35, "pa": 0.25,
                 "oh": 2.6, "od": 3.0, "oa": 4.0}]
    brackets = {"40-50": {"n": 20, "hit": 0.10}}
    bets = evaluate(rows_low, select_argmax, guard=True, brackets=brackets)
    assert len(bets) == 1