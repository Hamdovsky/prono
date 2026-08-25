import os
import sys
import importlib

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.join(HERE, "..", "core")
if CORE not in sys.path:
    sys.path.insert(0, CORE)

import ml_ensemble


def test_v4_gate_off_returns_unchanged():
    os.environ["V4_ENSEMBLE_ENABLED"] = "off"
    importlib.reload(ml_ensemble)
    ph, pd_, pa = 0.4, 0.3, 0.3
    out = ml_ensemble.apply_v4_ensemble(ph, pd_, pa, {"league": "Ligue 1"}, True)
    assert out[0] == ph and out[1] == pd_ and out[2] == pa
    assert out[3] == ""  # no +V4-Ensemble tag
    os.environ.pop("V4_ENSEMBLE_ENABLED", None)
    importlib.reload(ml_ensemble)


def test_v4_weight_defaults_to_0_85(monkeypatch):
    # force empty calibration so fallback path is taken
    monkeypatch.setattr(ml_ensemble, "_load_calibration_weights", lambda: {})
    assert abs(ml_ensemble._get_v4_weight("Some League") - 0.85) < 1e-9


def test_v4_weight_reads_per_league(monkeypatch):
    monkeypatch.setattr(
        ml_ensemble,
        "_load_calibration_weights",
        lambda: {"Ligue 1": {"v4_weight": 0.60}},
    )
    assert abs(ml_ensemble._get_v4_weight("Ligue 1") - 0.60) < 1e-9
    assert abs(ml_ensemble._get_v4_weight("Other") - 0.85) < 1e-9


def test_v4_weight_clamped(monkeypatch):
    monkeypatch.setattr(
        ml_ensemble,
        "_load_calibration_weights",
        lambda: {"X": {"v4_weight": 5.0}},
    )
    assert ml_ensemble._get_v4_weight("X") == 1.0
