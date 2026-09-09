"""
conftest.py — fixtures partagées pour le test d'intégration général.

But : centraliser la configuration réseau (services à tester), les URLs, et
les helpers de skip conditionnel. Les tests sont marqués pour permettre un
lancement partiel (ex. `pytest -m "not slow"` pour CI rapide).

2026-09-09 — créé pour tests/test_general_integration.py.
"""
from __future__ import annotations
import os
import socket
import sys
import urllib.error
import urllib.request
import json
import time
from pathlib import Path

import pytest

# Permettre l'import de modules core/ (et scripts/) depuis la racine
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "core"))
sys.path.insert(0, str(ROOT / "scripts"))

# ── Config (env-overridable) ───────────────────────────────────────────────
PIXELRAG_URL = os.environ.get("PIXELRAG_URL", "http://127.0.0.1:30002").rstrip("/")
FASTAPI_URL = os.environ.get("FASTAPI_URL", "http://127.0.0.1:8000").rstrip("/")
REDIS_HOST = os.environ.get("REDIS_HOST", "127.0.0.1")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))

# Event Sofascore de test (réel, public, terminé) — utilisé pour les tests
# qui font un appel réseau PixelRAG et FastAPI /predict.
TEST_EVENT_ID = int(os.environ.get("TEST_SOFASCORE_EVENT_ID", "11366885"))
TEST_HOME_TEAM = os.environ.get("TEST_HOME_TEAM", "FC Zbrojovka Brno")
TEST_AWAY_TEAM = os.environ.get("TEST_AWAY_TEAM", "Slezsk\u00fd FC Opava")


# ── Helpers réseau ─────────────────────────────────────────────────────────
def _tcp_open(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (OSError, socket.timeout):
        return False


def _http_get(url: str, timeout: float = 5.0):
    """GET avec gestion d'erreur silencieuse. Retourne (status, json_or_text, error)."""
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            ct = r.headers.get("content-type", "")
            raw = r.read().decode("utf-8", errors="replace")
            try:
                return r.status, json.loads(raw), None
            except json.JSONDecodeError:
                return r.status, raw, None
    except urllib.error.HTTPError as e:
        return e.code, None, str(e)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return None, None, str(e)


def _http_post(url: str, body: dict, timeout: float = 60.0):
    try:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url, data=data, headers={"Content-Type": "application/json", "Accept": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8")), None
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8")), None
        except Exception:
            return e.code, None, str(e)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return None, None, str(e)


# ── Fixtures : skips conditionnels ─────────────────────────────────────────
def _skip_if_down(host: str, port: int, name: str):
    if not _tcp_open(host, port, timeout=1.0):
        pytest.skip(f"{name} non joignable sur {host}:{port}")


@pytest.fixture(scope="session")
def pixelrag_url() -> str:
    _skip_if_down("127.0.0.1", 30002, "PixelRAG-lite (serveur vision)")
    return PIXELRAG_URL


@pytest.fixture(scope="session")
def fastapi_url() -> str:
    _skip_if_down("127.0.0.1", 8000, "FastAPI inference")
    return FASTAPI_URL


@pytest.fixture(scope="session")
def redis_up() -> bool:
    return _tcp_open(REDIS_HOST, REDIS_PORT, timeout=1.0)


@pytest.fixture(scope="session")
def pixelrag_health(pixelrag_url):
    status, body, err = _http_get(f"{pixelrag_url}/health", timeout=4.0)
    if status != 200 or not isinstance(body, dict):
        pytest.skip(f"PixelRAG /health KO: status={status} err={err}")
    return body


@pytest.fixture(scope="session")
def pixelrag_status(pixelrag_url):
    status, body, err = _http_get(f"{pixelrag_url}/status", timeout=4.0)
    if status != 200 or not isinstance(body, dict):
        pytest.skip(f"PixelRAG /status KO: status={status} err={err}")
    return body


@pytest.fixture(scope="session")
def fastapi_health(fastapi_url):
    status, body, err = _http_get(f"{fastapi_url}/health", timeout=8.0)
    if status != 200 or not isinstance(body, dict):
        pytest.skip(f"FastAPI /health KO: status={status} err={err}")
    return body
