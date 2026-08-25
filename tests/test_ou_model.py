"""
Tests du modele O/U (Q5) : inference logistique calibree par ligne + fallback.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.ou_model import ou_prob

_CALIB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "ou_model.json")


def test_ou_prob_in_range():
    for tx in (1.0, 2.5, 4.0):
        for line in (2.5, 3.5):
            v = ou_prob(tx, line)
            assert v is None or 0.0 <= v <= 1.0


def test_ou_prob_monotone_in_total_xg():
    lo = ou_prob(1.5, 2.5)
    hi = ou_prob(3.5, 2.5)
    assert hi > lo


def test_ou_model_improves_on_baseline():
    if not os.path.exists(_CALIB):
        return
    with open(_CALIB) as f:
        c = json.load(f)
    for line in (2.5, 3.5):
        blk = c[f"L{line}"]
        assert blk["logloss_model"] < blk["logloss_baseline"]


def test_ou_prob_fallback_without_calib(monkeypatch):
    import core.ou_model as om
    monkeypatch.setattr(om, "_load", lambda *a, **k: None)
    assert om.ou_prob(2.5, 2.5) is None
