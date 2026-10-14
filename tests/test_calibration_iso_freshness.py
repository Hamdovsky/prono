import os
import json
import sys
import importlib

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.join(HERE, "..", "core")
if CORE not in sys.path:
    sys.path.insert(0, CORE)

import calibration_iso


def _write_tmp_backtest(tmp_path, updated=None):
    p = tmp_path / "backtest_results.json"
    data = {"matches": 1}
    if updated is not None:
        data["updated"] = updated
    p.write_text(json.dumps(data), encoding="utf-8")
    return str(p)


def test_backtest_fresh_recent(tmp_path, monkeypatch):
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    monkeypatch.setattr(calibration_iso, "BACKTEST_PATH", _write_tmp_backtest(tmp_path, now))
    assert calibration_iso._backtest_is_fresh() is True


def test_backtest_stale_old(tmp_path, monkeypatch):
    from datetime import datetime, timedelta, timezone
    old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    monkeypatch.setattr(calibration_iso, "BACKTEST_PATH", _write_tmp_backtest(tmp_path, old))
    assert calibration_iso._backtest_is_fresh() is False


def test_backtest_missing_file(tmp_path, monkeypatch):
    monkeypatch.setattr(calibration_iso, "BACKTEST_PATH", str(tmp_path / "nope.json"))
    assert calibration_iso._backtest_is_fresh() is False


def test_backtest_missing_updated(tmp_path, monkeypatch):
    monkeypatch.setattr(calibration_iso, "BACKTEST_PATH", _write_tmp_backtest(tmp_path, None))
    assert calibration_iso._backtest_is_fresh() is False


def _write_tmp_backtest_timestamp(tmp_path, timestamp):
    p = tmp_path / "backtest_results.json"
    p.write_text(json.dumps({"matches": 1, "timestamp": timestamp}), encoding="utf-8")
    return str(p)


def _dump_platt_as_main_pickle(path):
    """Reproduit l'artefact réel du fit : classe référencée `__main__`.
    L'attribut est retiré de `__main__` APRÈS le dump pour que le rechargement
    exige la branche alias de `_load_model()` (sinon le test passerait à tort)."""
    import pickle
    import sys

    cls = calibration_iso.PlattCalibrator
    main = sys.modules["__main__"]
    original_module = cls.__module__
    already_present = hasattr(main, "PlattCalibrator")
    original_attr = getattr(main, "PlattCalibrator", None)
    cls.__module__ = "__main__"
    main.PlattCalibrator = cls
    try:
        with open(path, "wb") as f:
            pickle.dump(cls(0.355271, -0.395564), f)
    finally:
        cls.__module__ = original_module
        if already_present:
            main.PlattCalibrator = original_attr
        else:
            del main.PlattCalibrator


def test_backtest_fresh_via_timestamp_field(tmp_path, monkeypatch):
    # E94 : le rapport réel porte `timestamp` (pas `updated`). Sans ce repli la
    # fraîcheur était faussement négative en permanence -> identité à vie.
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    monkeypatch.setattr(
        calibration_iso, "BACKTEST_PATH", _write_tmp_backtest_timestamp(tmp_path, now)
    )
    assert calibration_iso._backtest_is_fresh() is True


def test_backtest_stale_via_timestamp_field(tmp_path, monkeypatch):
    from datetime import datetime, timedelta, timezone
    old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    monkeypatch.setattr(
        calibration_iso, "BACKTEST_PATH", _write_tmp_backtest_timestamp(tmp_path, old)
    )
    assert calibration_iso._backtest_is_fresh() is False


def test_load_model_handles_main_pickle(tmp_path, monkeypatch):
    # E94 : le fit tourne en `__main__` -> classe picklée `__main__.PlattCalibrator`.
    # Depuis un import, _load_model() devait quand même la décharger (sinon la
    # calibration retombait silencieusement sur le Platt v54 figé).
    p = tmp_path / "isotonic_model.pkl"
    _dump_platt_as_main_pickle(p)

    monkeypatch.setattr(calibration_iso, "MODEL_PATH", str(p))
    model = calibration_iso._load_model()
    assert model is not None
    assert isinstance(model, calibration_iso.PlattCalibrator)


def test_load_model_missing_file_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(calibration_iso, "MODEL_PATH", str(tmp_path / "nope.pkl"))
    assert calibration_iso._load_model() is None


def test_isotonic_calibrate_applies_when_fresh(tmp_path, monkeypatch):
    from datetime import datetime, timezone

    p = tmp_path / "isotonic_model.pkl"
    _dump_platt_as_main_pickle(p)
    monkeypatch.setattr(calibration_iso, "MODEL_PATH", str(p))
    now = datetime.now(timezone.utc).isoformat()
    monkeypatch.setattr(
        calibration_iso, "BACKTEST_PATH", _write_tmp_backtest_timestamp(tmp_path, now)
    )
    monkeypatch.setenv("ISO_RUNTIME_APPLY", "true")

    p_in = (0.75, 0.13, 0.12)
    out = calibration_iso.isotonic_calibrate(*p_in)

    # sur-confiance corrigée vers la réalité, somme conservée, argmax préservé
    assert out[0] < p_in[0]
    assert abs(sum(out) - 1.0) < 1e-9
    assert max(range(3), key=lambda i: out[i]) == 0
    assert all(0.0 <= v <= 1.0 for v in out)


def test_isotonic_neutralized_when_stale(tmp_path, monkeypatch):
    # model present but backtest stale -> calibration must be neutralized (identity)
    monkeypatch.setattr(calibration_iso, "_load_model", lambda: object())
    from datetime import datetime, timedelta, timezone
    old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    monkeypatch.setattr(calibration_iso, "BACKTEST_PATH", _write_tmp_backtest(tmp_path, old))
    p = (0.6, 0.2, 0.2)
    out = calibration_iso.isotonic_calibrate(*p)
    assert np.allclose(out, p)
