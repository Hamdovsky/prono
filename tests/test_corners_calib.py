"""
Tests du calibrage corners (Q2) : Negative Binomial P(Over/Under ligne).
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.corners_calib import p_over_corner, p_under_corner, load_calibration, negbinom_pmf


def test_p_over_monotone_in_mu():
    alpha = 0.021
    lo = p_over_corner(8.0, 9.5, alpha=alpha)
    hi = p_over_corner(12.0, 9.5, alpha=alpha)
    assert lo is not None and hi is not None
    assert lo < 0.5 < hi
    assert hi > lo


def test_p_over_under_sum_to_one():
    alpha = 0.021
    for mu in (8.0, 10.11, 12.0):
        pov = p_over_corner(mu, 9.5, alpha=alpha)
        pud = p_under_corner(mu, 9.5, alpha=alpha)
        assert abs(pov + pud - 1.0) < 1e-9


def test_p_over_bounds():
    for mu in (5.0, 10.0, 20.0):
        v = p_over_corner(mu, 9.5, alpha=0.021)
        assert 0.0 <= v <= 1.0


def test_calibration_global_matches_archive():
    # mu/alpha par defaut = les valeurs fittees sur l'archive (train_corners)
    calib = load_calibration()
    if calib.get("n", 0) >= 200:
        # P(Over 9.5) predite doit etre proche de la observee (ecart < 0.05)
        pred = p_over_corner(calib["mu"], calib["line"], alpha=calib["alpha"])
        obs = calib.get("p_over_observed")
        assert obs is not None
        assert abs(pred - obs) < 0.05


def test_pmf_sums_to_one():
    alpha = 0.021
    mu = 10.11
    total = sum(negbinom_pmf(k, mu, alpha) for k in range(0, 60))
    assert abs(total - 1.0) < 1e-6


def test_p_over_invalid_inputs():
    assert p_over_corner(None, 9.5) is None
    assert p_over_corner(-1, 9.5) is None
