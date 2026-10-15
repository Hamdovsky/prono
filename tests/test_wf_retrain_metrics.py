import importlib.util
import os

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

spec = importlib.util.spec_from_file_location(
    "eval_v55_walkforward_retrain",
    os.path.join(ROOT, "scripts", "eval_v55_walkforward_retrain.py"),
)
wf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wf)


def test_brier_perfect_is_zero():
    proba = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
    y = np.array([0, 1, 2])
    assert wf.brier_score(proba, y) < 1e-12


def test_brier_uniform_is_two_thirds():
    proba = np.full((4, 3), 1.0 / 3.0)
    y = np.array([0, 1, 2, 0])
    assert abs(wf.brier_score(proba, y) - (2.0 / 3.0)) < 1e-9


def test_strength_perfect_predictions():
    proba = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
    y = np.array([0, 1, 2])
    m = wf.strength(y, proba)
    assert m["n"] == 3
    assert m["acc"] == 1.0
    assert m["logloss"] < 1e-6
    assert m["brier"] < 1e-6
    assert m["ece"] < 1e-6


def test_strength_normalizes_rows():
    proba = np.array([[0.6, 0.3, 0.1]]) * 3.0
    y = np.array([0])
    m = wf.strength(y, proba)
    assert m["acc"] == 1.0
    assert abs(m["logloss"] - (-np.log(0.6))) < 1e-9


def test_ece_detects_miscalibration():
    conf = np.full(100, 0.9)
    proba = np.column_stack([conf, np.zeros(100), 1.0 - conf])
    y = np.zeros(100, dtype=int)
    y[:50] = 1
    ece = wf.ece_score(proba, y)
    assert ece > 0.3
