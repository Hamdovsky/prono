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


def test_isotonic_neutralized_when_stale(tmp_path, monkeypatch):
    # model present but backtest stale -> calibration must be neutralized (identity)
    monkeypatch.setattr(calibration_iso, "_load_model", lambda: object())
    from datetime import datetime, timedelta, timezone
    old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    monkeypatch.setattr(calibration_iso, "BACKTEST_PATH", _write_tmp_backtest(tmp_path, old))
    p = (0.6, 0.2, 0.2)
    out = calibration_iso.isotonic_calibrate(*p)
    assert np.allclose(out, p)
