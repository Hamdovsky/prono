"""Tests du Proxy Manager : parsing, cache/refresh, fallback & rotation.

Simule des réponses HTTP (403 direct puis succès via proxy) sans réseau réel.
"""
from __future__ import annotations

import pytest

from proxy_manager import (
    ProxyManager, _parse_list, fetch_with_proxy, get_manager, set_manager,
)


class FakeResp:
    def __init__(self, status_code: int, text: str = "", content: bytes = b"ok"):
        self.status_code = status_code
        self.text = text
        self.content = content

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


@pytest.fixture(autouse=True)
def _clean_manager():
    set_manager(None)
    yield
    set_manager(None)


# ── Parsing ──────────────────────────────────────────────────────

def test_parse_list_extraie_host_port() -> None:
    text = (
        "# comment\n"
        "1.2.3.4:8080\n"
        "http://5.6.7.8:3128\n"
        "user:pass@9.9.9.9:1080\n"
        "invalide\n"
        "10.0.0.1:99999\n"
    )
    assert _parse_list(text) == ["1.2.3.4:8080", "5.6.7.8:3128", "9.9.9.9:1080"]


# ── Cache / refresh ─────────────────────────────────────────────

def test_refresh_marque_le_cache_et_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    called = {"n": 0}

    def fake_get(url, headers=None, timeout=None):
        called["n"] += 1
        return FakeResp(200, text="a:1\nb:2\n")

    monkeypatch.setattr("proxy_manager.requests.get", fake_get)
    m = ProxyManager(sources=["https://src1"], refresh_min=0.1, fetch_timeout=1.0)
    assert m.get() in ("a:1", "b:2")
    assert called["n"] == 1
    assert m.pool_size == 2
    assert m.last_fetch_error is None


def test_pool_vide_si_sources_injoignables(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_get(url, headers=None, timeout=None):
        raise OSError("ECONNRESET: connexion réinitialisée")

    monkeypatch.setattr("proxy_manager.requests.get", fake_get)
    m = ProxyManager(refresh_min=0, fetch_timeout=1.0)
    assert m.get() is None
    assert m.pool_size == 0
    assert m.last_fetch_error is not None


def test_mark_bad_exclut_du_round_robin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("proxy_manager.requests.get",
                        lambda *a, **k: FakeResp(200, text="a:1\nb:2\n"))
    m = ProxyManager(refresh_min=0)
    m.get()
    m.mark_bad("a:1")
    proxy = m.get()
    while proxy and proxy == "a:1":
        proxy = m.get()
    assert proxy in ("b:2", None)
    assert m.bad_count == 1


# ── Fallback & rotation ─────────────────────────────────────────

def test_direct_succes_pas_de_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    used_proxies: list[str | None] = []

    def fake_get(url, headers=None, timeout=None, proxies=None):
        used_proxies.append(proxies)
        return FakeResp(200, content=b"direct")

    monkeypatch.setattr("proxy_manager.requests.get", fake_get)
    m = ProxyManager(refresh_min=0)
    resp = fetch_with_proxy("https://exemple.fr/data", manager=m)
    assert resp.content == b"direct"
    assert used_proxies == [None]


def test_403_declenche_rotation_puis_succes(monkeypatch: pytest.MonkeyPatch) -> None:
    """403 direct -> health-check 403 -> proxy suivant 200 : succès via proxy."""
    monkeypatch.setattr("proxy_manager.requests.get",
                        lambda *a, **k: FakeResp(200, text="p1:80\np2:80\n"))
    m = ProxyManager(refresh_min=0)
    m.get()
    m._cursor = 0  # on reparcourt le pool depuis le début

    calls: list[dict] = []

    def fake_get(url, headers=None, timeout=None, proxies=None):
        calls.append({"proxies": proxies})
        if proxies is None:
            return FakeResp(403, content=b"blocked")
        if proxies["http"] == "http://p1:80":
            return FakeResp(403, content=b"blocked")
        return FakeResp(200, content=b"via-p2")

    monkeypatch.setattr("proxy_manager.requests.get", fake_get)
    resp = fetch_with_proxy("https://exemple.fr/data", manager=m, max_attempts=4)
    assert resp.content == b"via-p2"
    assert calls[-1]["proxies"] == {"http": "http://p2:80", "https": "http://p2:80"}
    assert m.bad_count == 1  # p1 exclu après 403


def test_tous_les_proxies_bloquent_leve_erreur(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("proxy_manager.requests.get",
                        lambda *a, **k: FakeResp(200, text="p1:80\n"))
    m = ProxyManager(refresh_min=0)
    m.get()

    def fake_get(url, headers=None, timeout=None, proxies=None):
        return FakeResp(403, content=b"blocked")

    monkeypatch.setattr("proxy_manager.requests.get", fake_get)
    with pytest.raises(RuntimeError):
        fetch_with_proxy("https://exemple.fr/data", manager=m, max_attempts=2)


def test_ecoconnreset_direct_declenche_rotation(monkeypatch: pytest.MonkeyPatch) -> None:
    import requests as _req
    monkeypatch.setattr("proxy_manager.requests.get",
                        lambda *a, **k: FakeResp(200, text="p1:80\n"))
    m = ProxyManager(refresh_min=0)
    m.get()
    m._cursor = 0

    def fake_get(url, headers=None, timeout=None, proxies=None):
        if proxies is None:
            raise _req.exceptions.ConnectionError("ECONNRESET: connexion réinitialisée par l'homologue")
        return FakeResp(200, content=b"recovered")

    monkeypatch.setattr("proxy_manager.requests.get", fake_get)
    resp = fetch_with_proxy("https://exemple.fr/data", manager=m, max_attempts=3)
    assert resp.content == b"recovered"


def test_singleton_get_manager() -> None:
    assert get_manager() is get_manager()