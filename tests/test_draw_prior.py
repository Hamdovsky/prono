import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.join(HERE, "..", "core")
if CORE not in sys.path:
    sys.path.insert(0, CORE)

import ml_ensemble


def test_apply_draw_prior_off_by_default_noop():
    out = ml_ensemble.apply_draw_prior(0.5, 0.2, 0.3, 1.0)
    assert out == (0.5, 0.2, 0.3)


def test_apply_draw_prior_boosts_draw_and_normalizes():
    p_h, p_d, p_a = ml_ensemble.apply_draw_prior(0.5, 0.2, 0.3, 1.5)
    assert abs(sum((p_h, p_d, p_a)) - 1.0) < 1e-9
    assert p_d > 0.2
    # draw share should increase relative to the 0.2/1.0 baseline
    assert p_d > 0.2 / 1.0


def test_apply_draw_prior_k_below_one_lowers_draw():
    p_h, p_d, p_a = ml_ensemble.apply_draw_prior(0.5, 0.2, 0.3, 0.5)
    assert p_d < 0.2
