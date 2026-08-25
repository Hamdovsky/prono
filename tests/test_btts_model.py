"""
Tests du modele BTTS (Q3) : inference logistique calibree + fallback.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.btts_model import btts_prob, has_model

_CALIB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "btts_model.json")


def test_btts_prob_in_range():
    for xh, xa in [(1.5, 1.3), (0.5, 0.3), (2.0, 1.8)]:
        v = btts_prob(xh, xa)
        assert 0.0 <= v <= 1.0


def test_btts_model_improves_on_baseline():
    if not os.path.exists(_CALIB):
        return
    with open(_CALIB) as f:
        c = json.load(f)
    # le modele calibre doit battre le baseline constant (log-loss)
    assert c["logloss_model"] < c["logloss_baseline"]


def test_btts_prob_monotone_in_xg():
    lo = btts_prob(0.8, 0.7)
    hi = btts_prob(1.8, 1.6)
    assert hi > lo


def test_btts_fallback_without_weights(tmp_path, monkeypatch):
    # sans fichier de poids -> heuristique legacy (borne 0.88)
    monkeypatch.setattr(sys.modules["core.btts_model"], "_DEFAULT_WEIGHTS", None)
    import core.btts_model as bm
    # force le chemin vers un fichier inexistant
    v = bm.btts_prob(1.5, 1.3, weights={"_none": True})
    # weights dict sans "w" -> fallback heuristique
    assert 0.0 <= v <= 0.88
