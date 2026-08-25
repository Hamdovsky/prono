"""Vérifie que le paramètre proxy est propagé jusqu'à scrape_url (offline).

Le pool de proxys libres (Node freeProxyPool) injecte un proxy dans le
TLS-bypass (cmd betexplorer). Ces tests garantissent que ce proxy arrive
bien aux appels scrape_url internes sans casser le comportement nominal.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))

from bypass_scraper import _match_odds_ajax_html, betexplorer_search  # noqa: E402


def _patch_scrape(monkeypatch, store):
    def fake_scrape_url(url, opts=None):
        store["opts"] = opts or {}
        return {"status": 200, "body": "", "url": url, "error": None, "fingerprint": "chrome124"}

    monkeypatch.setattr("bypass_scraper.scrape_url", fake_scrape_url)


def test_betexplorer_search_passes_proxy(monkeypatch):
    store = {}
    _patch_scrape(monkeypatch, store)
    betexplorer_search("TeamA", "TeamB", "Promosport", proxy="http://1.2.3.4:8080")
    assert store["opts"].get("proxy") == "http://1.2.3.4:8080"


def test_betexplorer_search_no_proxy_by_default(monkeypatch):
    store = {}
    _patch_scrape(monkeypatch, store)
    betexplorer_search("TeamA", "TeamB", "Promosport")
    assert "proxy" not in store["opts"]


def test_match_odds_ajax_proxy(monkeypatch):
    store = {}
    _patch_scrape(monkeypatch, store)
    _match_odds_ajax_html("abc12345", "ou", proxy="http://9.9.9.9:3128")
    assert store["opts"].get("proxy") == "http://9.9.9.9:3128"


def test_match_odds_ajax_no_proxy_by_default(monkeypatch):
    store = {}
    _patch_scrape(monkeypatch, store)
    _match_odds_ajax_html("abc12345", "ou")
    assert "proxy" not in store["opts"]