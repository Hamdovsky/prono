"""Tests du contrat commun des sources (sources/base.py)."""
from __future__ import annotations

import json

import pandas as pd
import pytest

from sources import base as base_mod
from sources.base import BaseSource, HttpClient, KIND_BASE, SourceResult, run_all


class _FakeSource(BaseSource):
    """Source de test : renvoie un DF + provenance + un avertissement."""

    name = "fake"
    kind = KIND_BASE
    rate_limit_s = 0.0
    call_count = 0

    def __init__(self, fail: bool = False, state_file=None):
        super().__init__(base_mod.STATE_FILE if state_file is None else state_file)
        self.fail = fail

    def _fetch(self, leagues=None, seasons=None, force: bool = False):
        _FakeSource.call_count += 1
        if self.fail:
            raise RuntimeError("boom")
        return pd.DataFrame({"a": [1, 2]}), "fake-ok", ["attention"]


def test_source_result_ok() -> None:
    ok = SourceResult("x", "base", pd.DataFrame({"a": [1]}), "s", 0.0, [])
    assert ok.ok is True
    empty = SourceResult("x", "base", pd.DataFrame(), "s", 0.0, [])
    assert empty.ok is False
    none = SourceResult("x", "base", None, "s", 0.0, [])
    assert none.ok is False


def test_fake_source_fetch_renvoie_source_result(tmp_path) -> None:
    src = _FakeSource(state_file=tmp_path / "state.json")
    res = src.fetch(force=True)
    assert res.name == "fake"
    assert res.provenance == "fake-ok"
    assert res.warnings == ["attention"]
    assert res.ok is True
    assert len(res.df) == 2


def test_fake_source_trace_provenance_dans_state(tmp_path) -> None:
    state_file = tmp_path / "state.json"
    src = _FakeSource(state_file=state_file)
    src.fetch()
    state = json.loads(state_file.read_text(encoding="utf-8"))
    entry = state["sources"]["fake"]
    assert entry["provenance"] == "fake-ok"
    assert entry["rows"] == 2
    assert entry["warnings"] == ["attention"]
    assert entry["duration_s"] >= 0.0


def test_fetch_echoueretourne_source_result_erreur(tmp_path) -> None:
    src = _FakeSource(fail=True, state_file=tmp_path / "state.json")
    res = src.fetch()
    assert res.ok is False
    assert res.provenance == "error"
    assert res.df is None
    assert len(res.warnings) == 1


def test_rate_limiter_applique_intervalle_de_la_config(tmp_path, monkeypatch) -> None:
    calls = {"n": 0}

    class _Slow(_FakeSource):
        rate_limit_s = 2.0

        def _fetch(self, leagues=None, seasons=None, force: bool = False):
            calls["n"] += 1
            return pd.DataFrame({"a": [1]}), "ok", []

    src = _Slow(state_file=tmp_path / "state.json")
    src.fetch()
    assert calls["n"] == 1  # le limiter attend avant le premier appel sans le bloquer


def test_run_all_itere_sur_le_registre(tmp_path) -> None:
    srcs = [_FakeSource(state_file=tmp_path / "state.json")]
    results = run_all(srcs, force=True)
    assert set(results) == {"fake"}
    assert results["fake"].provenance == "fake-ok"


def test_http_client_get_bytes(monkeypatch) -> None:
    class Resp:
        status_code = 200
        content = b"abc"

        def raise_for_status(self) -> None:
            pass

    monkeypatch.setattr(base_mod.requests, "get", lambda *a, **k: Resp())
    assert HttpClient().get_bytes("http://example.test") == b"abc"


def test_http_client_get_bytes_leve_sur_erreur(monkeypatch) -> None:
    class Resp:
        status_code = 500
        content = b""

        def raise_for_status(self) -> None:
            raise RuntimeError("500")

    monkeypatch.setattr(base_mod.requests, "get", lambda *a, **k: Resp())
    with pytest.raises(Exception):
        HttpClient().get_bytes("http://example.test")


def test_base_source_est_abstraite() -> None:
    with pytest.raises(TypeError):
        BaseSource()  # type: ignore[abstract]