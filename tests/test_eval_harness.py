import importlib.util
import os

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

spec = importlib.util.spec_from_file_location(
    "eval_harness", os.path.join(ROOT, "scripts", "eval_harness.py")
)
eh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eh)


def test_metrics_perfect_predictions():
    proba = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
    y = np.array([0, 1, 2])
    m = eh.metrics(proba, y)
    assert m["n"] == 3
    assert m["acc"] == 1.0
    assert m["logloss"] < 1e-6
    assert m["brier"] < 1e-6
    assert m["ece"] < 1e-6


def test_metrics_known_case():
    proba = np.array([[0.6, 0.3, 0.1], [0.2, 0.5, 0.3]])
    y = np.array([0, 2])
    m = eh.metrics(proba, y)
    assert m["acc"] == 0.5
    assert abs(m["brier"] - (((0.6 - 1) ** 2 + 0.09 + 0.01) + (0.04 + 0.25 + (0.3 - 1) ** 2)) / 2) < 1e-9


def test_label_for_1x2():
    df = pd.DataFrame(
        {
            "ftr": ["H", "D", "A", "H"],
            "fthg": [2, 1, 0, 3],
            "ftag": [0, 1, 1, 1],
        }
    )
    y = eh.label_for(df, "1x2")
    assert list(y) == [0, 1, 2, 0]


def test_label_for_ou25_and_btts():
    df = pd.DataFrame(
        {
            "ftr": ["H", "D", "A"],
            "fthg": [2, 1, 0],
            "ftag": [1, 1, 1],
        }
    )
    assert list(eh.label_for(df, "ou25")) == [1, 0, 0]
    assert list(eh.label_for(df, "btts")) == [1, 1, 0]


def test_walk_forward_runs_and_returns_calibrated_rows():
    rng = np.random.RandomState(0)
    n = 400
    df = pd.DataFrame({f: rng.normal(size=n) for f in eh.BASE_FEATS})
    y = rng.randint(0, 3, size=n)
    proba, yv = eh.walk_forward(df, y, eh.BASE_FEATS, "lr", folds=3, embargo=5)
    assert len(yv) > 0
    assert proba.shape[1] == 3
    assert not np.isnan(proba).any()
    assert np.allclose(proba.sum(axis=1), 1.0, atol=1e-6)
    assert set(np.unique(yv)).issubset({0, 1, 2})
