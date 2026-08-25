import os
import sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.join(HERE, "..", "core")
if CORE not in sys.path:
    sys.path.insert(0, CORE)

from eval_v55_walkforward import (
    chronological_split,
    evaluate_predictions,
    brier_score,
    ece_score,
)


def test_chronological_split_no_overlap_and_ordered():
    dates = ["2024-01-01", "2023-01-01", "2024-06-01", "2022-01-01",
             "2023-07-01", "bad-date", "2025-01-01"]
    train_idx, test_idx = chronological_split(dates, test_frac=0.34)
    assert len(train_idx) + len(test_idx) == 6  # bad-date dropped
    assert set(train_idx).isdisjoint(set(test_idx))
    # train indices correspond to earlier dates than test indices
    parsed = {i: d for i, d in enumerate(dates) if d != "bad-date"}
    train_dates = [parsed[i] for i in train_idx]
    test_dates = [parsed[i] for i in test_idx]
    assert max(train_dates) < min(test_dates)


def test_evaluate_predictions_perfect():
    y = np.array([0, 1, 2, 0, 2, 1, 0, 1])
    proba = np.zeros((len(y), 3))
    for i, lab in enumerate(y):
        proba[i, lab] = 1.0
    m = evaluate_predictions(y, proba)
    assert m["accuracy"] == 1.0
    assert abs(m["log_loss"]) < 1e-9
    assert m["brier"] == 0.0
    assert m["ece"] == 0.0
    assert m["per_class"]["D"]["recall"] == 1.0


def test_brier_nonzero_for_wrong():
    y = np.array([0])
    proba = np.array([[0.0, 0.0, 1.0]])  # predicted away, true home
    # multiclass Brier = sum_k (p_k - o_k)^2 = (0-1)^2 + 0 + (1-0)^2 = 2.0
    assert abs(brier_score(proba, y) - 2.0) < 1e-9


def test_ece_in_range():
    rng = np.random.default_rng(0)
    y = rng.integers(0, 3, size=500)
    proba = rng.random((500, 3))
    proba = proba / proba.sum(axis=1, keepdims=True)
    ece = ece_score(proba, y)
    assert 0.0 <= ece <= 1.0
