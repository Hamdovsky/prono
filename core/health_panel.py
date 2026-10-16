"""
health_panel — pont entre le Command Center (Streamlit) et les outils de
sante Node (E105).

POURQUOI : la page "System Health" du Command Center pingait
`localhost:5000/health`, ou RIEN n'ecoute (l'API est sur 3001) — elle
affichait donc "API hors-ligne" en permanence, meme quand tout allait bien.
Une alarme toujours rouge finit ignoree : c'est ainsi que l'arret d'API_CORE
est reste invisible. Ce module expose les vrais controles :

  - `service_status()` : sonde TCP reelle des 5 services (3001/8000/5173/
    8501/30002) + sonde HTTP la ou un chemin de sante est connu (API
    /api/health, ML /health). Les deux familles d'adresses sont testees :
    Vite n'ecoute que sur ::1 (lecon du watchdog E105). Le voyant distingue
    'up' / 'hung' (TCP ok mais HTTP muet, cas E106) / 'down'.
  - `run_health_check()` : lance `npm run health` (~30 s) et parse le resume
    PASSED / WARNINGS / FAILED / SYSTEM STATUS.
  - `run_backfill_preview()` / `run_backfill_apply()` : dry-run puis ecriture
    de la reconstruction xG (E105).

Les fonctions `parse_*` sont pures et testees (tests/test_health_panel.py).
Les fonctions `run_*` sont appelees uniquement depuis un bouton Streamlit,
jamais au chargement de la page : un diagnostic de 30 s ne doit pas bloquer
l'affichage.
"""

import os
import re
import shutil
import socket
import subprocess
import http.client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEALTH_SCRIPT = os.path.join(ROOT, "scripts", "titanium_health_check.js")
BACKFILL_SCRIPT = os.path.join(ROOT, "scripts", "backfill_xg.js")

# Services supervises : meme perimetre que scripts/watchdog.js pour les trois
# critiques, plus les deux que le watchdog laisse volontairement de cote
# (COMMAND est lent au premier boot, PIXELRAG est pilote par AUTOHEAL).
SERVICES = [
    {"name": "API_CORE", "port": 3001, "kind": "API Node.js (predictions, cotes)", "http_path": "/api/health"},
    {"name": "ML_CORE", "port": 8000, "kind": "Inference Python FastAPI", "http_path": "/health"},
    {"name": "UI_DASH", "port": 5173, "kind": "Dashboard Vite", "http_path": None},
    {"name": "COMMAND", "port": 8501, "kind": "Command Center (cette page)", "http_path": None},
    {"name": "PIXELRAG", "port": 30002, "kind": "PixelRAG visuel", "http_path": None},
]

# Meme lecon que le watchdog : tester les deux familles, Vite n'ecoute
# que sur ::1 tandis que l'API ecoute sur 0.0.0.0.
PROBE_HOSTS = ("127.0.0.1", "::1")

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

# Resume final de titanium_health_check.js, codes ANSI eventuellement inclus.
RE_PASSED = re.compile(r"PASSED\s*:\s*(\d+)")
RE_WARNINGS = re.compile(r"WARNINGS\s*:\s*(\d+)")
RE_FAILED = re.compile(r"FAILED\s*:\s*(\d+)")
RE_STATUS = re.compile(r"SYSTEM STATUS\s*:\s*(\w+)")

# "11 match(s) sans xG" / "11 match(s) seraient mis a jour" /
# "11 match(s) mis a jour" / "Rien a faire."
RE_BACKFILL_COUNT = re.compile(r"(\d+)\s+match\(s\)")
RE_BACKFILL_NONE = re.compile(r"Rien [aà] faire")


def strip_ansi(text):
    """Retire les codes couleur ANSI pour un affichage Streamlit propre."""
    if not text:
        return ""
    return ANSI_RE.sub("", text)


def probe_tcp(port, timeout=2.0, hosts=PROBE_HOSTS):
    """Vrai si l'un des hotes accepte une connexion TCP sur ce port."""
    for host in hosts:
        try:
            family = socket.AF_INET6 if ":" in host else socket.AF_INET
            sock = socket.socket(family, socket.SOCK_STREAM)
            sock.settimeout(timeout)
            try:
                sock.connect((host, port))
                return True
            finally:
                sock.close()
        except (OSError, socket.error):
            continue
    return False


def service_status(timeout=2.0):
    """Sonde reelle des services. Retourne une liste de dicts {name, port,
    kind, alive, http, state}. Aucune assertion en dur : que du mesure.

    - alive : le port accepte le TCP (comme avant).
    - http : True/False quand le service expose un chemin de sante connu,
      None sinon (pas de chemin connu : on ne sait pas dire).
    - state : 'up' (TCP ok + HTTP ok ou sans objet), 'hung' (TCP ok mais
      HTTP muet — le cas E106 : uvicorn LISTENING mais /health en timeout),
      'down' (TCP refuse).
    """
    out = []
    for svc in SERVICES:
        alive = probe_tcp(svc["port"], timeout=timeout)
        http_ok = None
        if alive and svc.get("http_path"):
            http_ok = probe_http(svc["port"], svc["http_path"], timeout=timeout)
        if not alive:
            state = "down"
        elif http_ok is False:
            state = "hung"
        else:
            state = "up"
        out.append(
            {
                "name": svc["name"],
                "port": svc["port"],
                "kind": svc["kind"],
                "alive": alive,
                "http": http_ok,
                "state": state,
            }
        )
    return out


def probe_http(port, path, timeout=2.0, hosts=PROBE_HOSTS):
    """Vrai si l'un des hotes repond HTTP < 500 sur ce chemin.

    Meme lecon que le watchdog E105 : tester les deux familles d'adresses.
    Un port qui accepte le TCP mais ne repond jamais au HTTP (hung E106)
    vaut False — c'est exactement le cas que le voyant TCP seul ratait.
    """
    for host in hosts:
        try:
            conn = http.client.HTTPConnection(host, port, timeout=timeout)
            try:
                conn.request("GET", path)
                res = conn.getresponse()
                res.read()
                if res.status < 500:
                    return True
            finally:
                conn.close()
        except (OSError, socket.error, http.client.HTTPException):
            continue
    return False


def find_node():
    """Chemin de node, ou 'node' si resolu via le PATH (meme convention que
    le bouton d'entrainement qui invoque 'python' nu)."""
    return shutil.which("node") or "node"


def parse_health_summary(text):
    """Extrait le resume final du health check.

    Retourne {'passed': int|None, 'warnings': int|None, 'failed': int|None,
    'status': str|None}. None = ligne absente (sortie tronquee ou ancien
    format) : l'appelant affiche un avertissement au lieu d'inventer.
    """
    clean = strip_ansi(text or "")

    def _num(rx):
        m = rx.search(clean)
        return int(m.group(1)) if m else None

    m = RE_STATUS.search(clean)
    return {
        "passed": _num(RE_PASSED),
        "warnings": _num(RE_WARNINGS),
        "failed": _num(RE_FAILED),
        "status": m.group(1) if m else None,
    }


def run_health_check(timeout=300):
    """Lance le diagnostic complet (~30 s). A appeler depuis un bouton
    Streamlit avec st.spinner, jamais au chargement de la page."""
    try:
        proc = subprocess.run(
            [find_node(), HEALTH_SCRIPT],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            cwd=ROOT,
        )
    except FileNotFoundError as exc:
        return {"ok": False, "error": "node introuvable : %s" % exc}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "diagnostic > %ds, abandonne" % timeout}
    output = strip_ansi((proc.stdout or "") + "\n" + (proc.stderr or ""))
    return {
        "ok": True,
        "returncode": proc.returncode,
        "summary": parse_health_summary(output),
        "output": output.strip(),
    }


def parse_backfill_preview(text):
    """Extrait le nombre de matchs concernes par le backfill xG.

    Retourne {'count': int|None}. None = sortie inattendue.
    """
    clean = strip_ansi(text or "")
    if RE_BACKFILL_NONE.search(clean):
        return {"count": 0}
    m = RE_BACKFILL_COUNT.search(clean)
    return {"count": int(m.group(1)) if m else None}


def _run_backfill(extra_args, timeout=180):
    try:
        proc = subprocess.run(
            [find_node(), BACKFILL_SCRIPT] + list(extra_args),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            cwd=ROOT,
        )
    except FileNotFoundError as exc:
        return {"ok": False, "error": "node introuvable : %s" % exc}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "backfill > %ds, abandonne" % timeout}
    output = strip_ansi((proc.stdout or "") + "\n" + (proc.stderr or ""))
    return {
        "ok": proc.returncode == 0,
        "preview": parse_backfill_preview(output),
        "output": output.strip(),
    }


def run_backfill_preview(timeout=180):
    """Dry-run : ne modifie jamais la base."""
    return _run_backfill([], timeout=timeout)


def run_backfill_apply(timeout=180):
    """Ecriture reelle. Le script Node est idempotent et ne touche que les
    lignes sans xG (E105) ; a n'appeler que depuis un bouton explicite."""
    return _run_backfill(["--apply"], timeout=timeout)
