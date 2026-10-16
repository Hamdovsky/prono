"""
Tests du pont health_panel (E105) : parsing pur, sans reseau ni processus.

Contexte : la page System Health pingait localhost:5000 (rien n'ecoute) et
affichait "hors-ligne" en permanence. Ces tests verrouillent les parseurs
qui alimentent la nouvelle page.
"""

import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "core"))

import health_panel
from health_panel import (
    PROBE_HOSTS,
    SERVICES,
    parse_backfill_preview,
    parse_health_summary,
    probe_http,
    probe_tcp,
    strip_ansi,
)


def test_strip_ansi_retire_les_couleurs():
    assert strip_ansi("\x1b[32m✔ PASSED   : 70\x1b[0m") == "✔ PASSED   : 70"


def test_strip_ansi_toler_none_et_vide():
    assert strip_ansi(None) == ""
    assert strip_ansi("") == ""


def test_parse_health_summary_cas_sain():
    text = "  ✔ PASSED   : 70\n  ⚠ WARNINGS : 0\n  ✘ FAILED   : 0\n  SYSTEM STATUS: HEALTHY\n"
    s = parse_health_summary(text)
    assert s == {"passed": 70, "warnings": 0, "failed": 0, "status": "HEALTHY"}


def test_parse_health_summary_avec_ansi():
    text = "\x1b[32m  ✔ PASSED   : 69\x1b[0m\n\x1b[31m  ✘ FAILED   : 1\x1b[0m\n\x1b[33m  SYSTEM STATUS: DEGRADED\x1b[0m"
    s = parse_health_summary(text)
    assert s["passed"] == 69
    assert s["warnings"] is None  # ligne absente -> None, jamais invente
    assert s["failed"] == 1
    assert s["status"] == "DEGRADED"


def test_parse_health_summary_sortie_tronquee():
    # Un crash en cours de route ne doit pas produire de chiffres inventes.
    s = parse_health_summary("Traceback (most recent call last): ...")
    assert s == {"passed": None, "warnings": None, "failed": None, "status": None}


def test_parse_backfill_preview_avec_matchs():
    s = parse_backfill_preview("[BACKFILL-XG] 11 match(s) sans xG parmi les matchs regles.")
    assert s == {"count": 11}


def test_parse_backfill_preview_rien_a_faire():
    s = parse_backfill_preview("[BACKFILL-XG] 0 match(s) sans xG.\n[BACKFILL-XG] Rien a faire.")
    assert s == {"count": 0}


def test_parse_backfill_preview_sortie_inattendue():
    assert parse_backfill_preview("boom") == {"count": None}


def test_sonde_les_deux_familles():
    # Regression watchdog E105 : Vite n'ecoute que sur ::1.
    assert "127.0.0.1" in PROBE_HOSTS
    assert "::1" in PROBE_HOSTS


def test_services_sans_doublon_de_port():
    ports = [s["port"] for s in SERVICES]
    assert len(set(ports)) == len(ports)


def test_services_couvre_api_et_ml():
    by_name = {s["name"]: s["port"] for s in SERVICES}
    assert by_name["API_CORE"] == 3001  # pas 5000 : c'etait le bug de la page
    assert by_name["ML_CORE"] == 8000


def test_probe_tcp_port_ferme():
    # Port quasi certainement libre : doit rester DOWN.
    assert probe_tcp(9, timeout=1.0) is False


class _OkHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"status":"ok"}'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def _free_port():
    import socket as _s
    s = _s.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def test_probe_http_repond_vrai():
    server = ThreadingHTTPServer(('127.0.0.1', 0), _OkHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert probe_http(port, '/health', timeout=2.0) is True
    finally:
        server.shutdown()
        thread.join(timeout=5)


def test_probe_http_port_ferme_vaut_faux():
    assert probe_http(_free_port(), '/health', timeout=1.0) is False


def test_services_http_path_connu_pour_api_et_ml():
    by_name = {s['name']: s for s in SERVICES}
    assert by_name['API_CORE']['http_path'] == '/api/health'
    assert by_name['ML_CORE']['http_path'] == '/health'
    assert by_name['UI_DASH']['http_path'] is None


def test_service_status_distribue_up_hung_down(monkeypatch):
    # Cas E106 : TCP ok + HTTP muet = hung, pas UP.
    monkeypatch.setattr(health_panel, 'probe_tcp', lambda port, timeout=2.0: True)
    monkeypatch.setattr(
        health_panel, 'probe_http', lambda port, path, timeout=2.0, hosts=None: False
    )
    states = {s['name']: s for s in health_panel.service_status(timeout=0.1)}
    assert states['API_CORE']['state'] == 'hung'
    assert states['API_CORE']['http'] is False
    # Sans chemin HTTP connu : TCP ok suffit pour UP.
    assert states['UI_DASH']['state'] == 'up'
    assert states['UI_DASH']['http'] is None

    monkeypatch.setattr(health_panel, 'probe_tcp', lambda port, timeout=2.0: False)
    states = {s['name']: s for s in health_panel.service_status(timeout=0.1)}
    assert all(s['state'] == 'down' for s in states.values())
