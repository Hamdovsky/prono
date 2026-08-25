"""
Tests du modele HT par match (Q4 bis) : inference logistique + fallback.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.ht_model import ht_prob, has_model

_CALIB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "ht_model.json")


def test_ht_prob_in_range():
    for xh, xa in [(1.5, 1.3), (0.4, 0.3), (2.0, 1.8)]:
        v = ht_prob(xh, xa, 10.0)
        assert v is None or 0.0 <= v <= 1.0


def test_ht_prob_monotone_in_xg():
    lo = ht_prob(0.6, 0.5, 6.0)
    hi = ht_prob(1.9, 1.7, 11.0)
    assert hi > lo


def test_ht_model_improves_baseline():
    if not os.path.exists(_CALIB):
        return
    with open(_CALIB) as f:
        c = json.load(f)
    assert c["logloss_model"] < c["logloss_baseline"]


def test_ht_prob_fallback_without_calib(monkeypatch):
    import core.ht_model as hm
    monkeypatch.setattr(hm, "_load", lambda *a, **k: None)
    assert hm.ht_prob(1.5, 1.3, 10.0) is None
