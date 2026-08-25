"""
Tests du walk-forward marches (A) : fonctions de bas niveau.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.eval_markets_walkforward import (
    fit_logistic,
    predict_logistic,
    poisson_p_gt,
    logloss,
    baseline_prob,
)


def test_poisson_p_gt_bounds():
    for k in (2, 3):
        p = poisson_p_gt(4.6, k)
        assert 0.0 <= p <= 1.0


def test_logloss_symmetric():
    assert abs(logloss(0.5, 1) - logloss(0.5, 0)) < 1e-9


def test_fit_predict_logistic_separates():
    X = [[0.3, 0.2]] * 50 + [[2.0, 1.8]] * 50
    y = [0] * 50 + [1] * 50
    m = fit_logistic(X, y)
    assert m is not None
    lo = predict_logistic(m, [[0.3, 0.2]])[0]
    hi = predict_logistic(m, [[2.0, 1.8]])[0]
    assert hi > lo


def test_baseline_prob_ranges():
    for name, xi in [("BTTS", [1.0, 1.0]), ("OU2.5", [4.6]), ("HT>0.5", [1.0, 1.0, 10.0])]:
        p = baseline_prob(name, xi)
        assert 0.0 <= p <= 1.0
