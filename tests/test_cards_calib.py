"""
Tests du calibrage cartons (D) : Negative Binomial P(Over/Under ligne).
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.cards_calib import p_over_cards, p_under_cards, load_calibration, negbinom_pmf


def test_p_over_monotone_in_mu():
    alpha = 0.03
    assert p_over_cards(3.0, 3.5, alpha=alpha) < 0.5 < p_over_cards(6.0, 3.5, alpha=alpha)


def test_p_over_under_sum_to_one():
    for mu in (3.0, 4.0, 6.0):
        pov = p_over_cards(mu, 3.5, alpha=0.03)
        pud = p_under_cards(mu, 3.5, alpha=0.03)
        assert abs(pov + pud - 1.0) < 1e-9


def test_p_over_bounds():
    for mu in (2.0, 4.0, 8.0):
        assert 0.0 <= p_over_cards(mu, 3.5, alpha=0.03) <= 1.0


def test_calibration_global_matches_archive():
    calib = load_calibration()
    if calib.get("n", 0) >= 200:
        pred = p_over_cards(calib["mu"], calib["line"], alpha=calib["alpha"])
        obs = calib.get("p_over_observed")
        assert obs is not None
        assert abs(pred - obs) < 0.05


def test_pmf_sums_to_one():
    total = sum(negbinom_pmf(k, 4.0, 0.03) for k in range(0, 60))
    assert abs(total - 1.0) < 1e-6


def test_p_over_invalid_inputs():
    assert p_over_cards(None, 3.5) is None
    assert p_over_cards(-1, 3.5) is None
