"""
E111 — la calibration Platt OU/BTTS : identite sans fichier, shrink mesure sinon.

Contexte : les logistiques OU/BTTS sur xG sont pires que la constante en brut
(Brier OU 0.2788 vs plancher 0.2466 sur TEST honnete) ; la Platt fittee sur
TRAIN les ramene au plancher (0.2437 / 0.2468). Ces tests verrouillent le
cablage : sans fichier calib, les sorties sont inchangees.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "core"))

from ou_model import ou_prob, apply_recal as ou_recal, _load_recal as ou_load_recal
from btts_model import btts_prob, apply_recal as btts_recal


def test_ou_recal_sans_fichier_est_identite(tmp_path, monkeypatch):
    monkeypatch.setattr("ou_model._RECAL_LOADED", False, raising=False)
    import ou_model
    monkeypatch.setattr(ou_model, "_RECAL", None)
    monkeypatch.setattr(ou_model, "_RECAL_LOADED", True)
    assert ou_recal(0.9) == 0.9
    assert ou_recal(0.1) == 0.1
    assert ou_recal(0.9, line=3.5) == 0.9


def test_ou_recal_preserve_ordre_et_bornes():
    recal = {"L2.5": {"a": 0.0535, "b": 0.3298, "n": 2867}}
    lo = ou_recal(0.1, recal=recal)
    mid = ou_recal(0.5, recal=recal)
    hi = ou_recal(0.9, recal=recal)
    assert 0.0 < lo < mid < hi < 1.0
    # Shrink massif vers le taux de base : les extremes s'ecrasent.
    assert hi - lo < 0.9 - 0.1


def test_btts_recal_sans_fichier_est_identite():
    assert btts_recal(0.7, recal=None if False else {}) == 0.7
    assert btts_recal(0.2, recal={}) == 0.2


def test_btts_recal_pente_nulle_vaut_constante():
    recal = {"a": -0.0084, "b": 0.1428, "n": 2867}
    import math
    base = 1.0 / (1.0 + math.exp(-0.1428))
    assert abs(btts_recal(0.05, recal=recal) - base) < 0.02
    assert abs(btts_recal(0.95, recal=recal) - base) < 0.02


def test_ou_prob_et_btts_prob_restent_des_probabilites():
    p_ou = ou_prob(2.9, 2.5)
    p_bt = btts_prob(1.4, 1.1)
    assert p_ou is not None and 0.0 < p_ou < 1.0
    assert 0.0 < p_bt < 1.0


def test_load_recal_fichier_manquant_vaut_none(tmp_path):
    assert ou_load_recal(path=str(tmp_path / "absent.json")) is None
