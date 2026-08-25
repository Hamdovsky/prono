"""Tests d'audit du moteur principal : M0 (trace), M1 (gate Meta-Refiner), M2 (gate Gap Learning)."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "core"))

import pytest


# --------------------------------------------------------------------------- M1
def test_meta_refiner_helper_default_off(monkeypatch):
    import core.ml_ensemble as me
    monkeypatch.delenv("META_REFINER_PY", raising=False)
    assert me.meta_refiner_python_enabled() is False
    monkeypatch.setenv("META_REFINER_PY", "on")
    assert me.meta_refiner_python_enabled() is True
    monkeypatch.setenv("META_REFINER_PY", "off")
    assert me.meta_refiner_python_enabled() is False


def test_run_xgboost_inference_meta_refiner_gate(monkeypatch):
    import core.ml_ensemble as me

    calls = {"refine": 0}

    def fake_refine(league, side, p):
        calls["refine"] += 1
        return float(p), 1.0

    monkeypatch.setattr(me, "refine_prediction", fake_refine)
    monkeypatch.setattr(me, "simulate_match_mc", lambda *a, **k: (0.5, 0.25, 0.25))

    class FakeBooster:
        def num_features(self):
            return 5

    fv = [0.1, 0.1, 0.1, 0.1, 0.1]

    def run():
        return me.run_xgboost_inference(
            fv, ["a", "b", "c", "d", "e"], FakeBooster(),
            {"p_h": 0.5, "p_d": 0.25, "p_a": 0.25}, {}, {}, "TestLeague", "T1",
        )

    monkeypatch.delenv("META_REFINER_PY", raising=False)
    run()
    assert calls["refine"] == 0, "refine ne doit pas etre appele par defaut"

    monkeypatch.setenv("META_REFINER_PY", "on")
    run()
    assert calls["refine"] == 3, "refine doit etre appele 3x quand META_REFINER_PY=on"


# --------------------------------------------------------------------------- M0
def test_record_engine_prob_trace_writes(tmp_path, monkeypatch):
    import core.prediction_engine as pe

    p = tmp_path / "trace.jsonl"
    monkeypatch.setenv("ENGINE_PROB_TRACE", str(p))
    pe.record_engine_prob_trace(
        "Arsenal", "Chelsea", "EPL", "2026-09-01",
        0.5, 0.25, 0.25, "src", False, True,
    )
    lines = p.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["home"] == "Arsenal" and rec["away"] == "Chelsea"
    assert rec["engine_exit"]["home"] == 0.5
    assert rec["gap_learning"] is True and rec["meta_refiner_py"] is False


# --------------------------------------------------------------------------- M2
def test_gap_learning_disabled_by_default(monkeypatch, tmp_path):
    import core.data_loader as dl

    f = tmp_path / "acc.json"
    f.write_text(json.dumps({
        "byLeague": {"EPL": [{"vote_was_misleading": True} for _ in range(5)]}
    }))
    monkeypatch.setattr(dl, "ACCURACY_LOG_PATH", str(f))

    d = {"home": 0.6, "draw": 0.2, "away": 0.2}

    monkeypatch.delenv("GAP_LEARNING_ENABLED", raising=False)
    out, corr = dl.apply_gap_learning_weight(dict(d), "EPL")
    assert out == d and corr == 0.0  # desactive -> unchanged

    monkeypatch.setenv("GAP_LEARNING_ENABLED", "on")
    out2, corr2 = dl.apply_gap_learning_weight(dict(d), "EPL")
    assert corr2 > 0 and abs(out2["home"] - 0.6) > 1e-9  # penalty appliquee


def test_gap_learning_reads_unified_byLeague(monkeypatch, tmp_path):
    import core.data_loader as dl

    f = tmp_path / "acc.json"
    # Ancien schema plat (sans byLeague) -> ne doit PAS etre lu
    f.write_text(json.dumps({"EPL": [{"vote_was_misleading": True}] * 5}))
    monkeypatch.setattr(dl, "ACCURACY_LOG_PATH", str(f))
    monkeypatch.setenv("GAP_LEARNING_ENABLED", "on")
    out, corr = dl.apply_gap_learning_weight({"home": 0.6, "draw": 0.2, "away": 0.2}, "EPL")
    assert corr == 0.0  # schema plat ignore -> pas de penalty
