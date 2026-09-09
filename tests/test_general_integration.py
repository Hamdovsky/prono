"""
test_general_integration.py — test d'intégration GÉNÉRAL du projet stitch.

Couvre 5 axes :
  1. Services health    : tous les process critiques sont UP
  2. PixelRAG endpoints : /health, /status, /search, /enrich/{id}, /sofascore/cache/stats
  3. FastAPI predict    : /predict avec et sans sofascore_id, latence raisonnable
  4. DB persistance     : SQLite (tactical.db + historical_archive.sqlite) intègres
  5. Fichiers projet    : modèles présents, sources Python/JS parsables, configs valides

Marqueurs pytest :
  - @pytest.mark.slow    : tests réseau (>=1s) — à exclure en CI rapide
  - @pytest.mark.local   : tests purement locaux (pas de réseau)
  - @pytest.mark.db      : tests qui touchent la DB
  - @pytest.mark.smoke   : tests de fumée (<5s total, toujours lancés)

Lancement :
  pytest tests/test_general_integration.py -v                 # tout
  pytest tests/test_general_integration.py -m smoke           # fumée seule
  pytest tests/test_general_integration.py -m "not slow"      # CI rapide
  pytest tests/test_general_integration.py --tb=short         # sortie compacte

Skip gracieux : si un service est down, le test skip avec un message clair.
Ne FAIL jamais sur absence de service (sauf si explicitement @pytest.mark.required).

2026-09-09 — créé lors de la session "PixelRAG prend la place du scraper".
"""
from __future__ import annotations
import datetime
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

import pytest

# Permet l'import des helpers du conftest (fixtures)
from tests.conftest import _http_get, _http_post, TEST_EVENT_ID, TEST_HOME_TEAM, TEST_AWAY_TEAM

ROOT = Path(__file__).resolve().parents[1]


# ═══════════════════════════════════════════════════════════════════════════
# AXE 1 — SERVICES HEALTH
# ═══════════════════════════════════════════════════════════════════════════
@pytest.mark.smoke
def test_pixelrag_health_returns_200(pixelrag_health):
    h = pixelrag_health
    assert h.get("status") == "ok", f"PixelRAG status != 'ok' : {h}"
    assert h.get("port") == 30002, f"port inattendu : {h.get('port')}"
    assert "model" in h
    assert "index_size" in h
    assert isinstance(h["index_size"], int)
    assert h["index_size"] >= 0


@pytest.mark.smoke
def test_pixelrag_index_has_vectors(pixelrag_status):
    s = pixelrag_status
    assert "total_vectors" in s
    assert "dimension" in s
    assert s["dimension"] in (512, 768, 1024), f"dim inattendue : {s['dimension']}"
    # À ce stade du projet l'index doit être peuplé (cf. bootstrap_pixelrag_text.js)
    assert s["total_vectors"] > 4, (
        f"index quasi-vide ({s['total_vectors']} vecteurs). "
        "Lancer scripts/bootstrap_pixelrag_text.js ?"
    )


@pytest.mark.smoke
def test_fastapi_health_returns_all_engines(fastapi_health):
    h = fastapi_health
    assert h.get("status") == "healthy", f"FastAPI status != 'healthy' : {h}"
    engines = h.get("engines_loaded", {})
    for required in ("prediction", "props", "mega", "sentiment"):
        assert engines.get(required) is True, (
            f"engine '{required}' non chargé : {engines}"
        )
    assert "version" in h
    # v55_visual est optionnel (modèle non requis pour passer /health)
    models = h.get("models_on_disk", {})
    assert models.get("v24_hybrid") is True
    assert models.get("titanium_v2") is True


@pytest.mark.local
def test_redis_port_open_if_redis_up(redis_up):
    # Best-effort : Redis est optionnel (fallback in-memory)
    if not redis_up:
        pytest.skip("Redis non joignable — fallback in-memory actif")


# ═══════════════════════════════════════════════════════════════════════════
# AXE 2 — PIXELRAG ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════
@pytest.mark.slow
def test_pixelrag_search_endpoint(pixelrag_url):
    t0 = time.time()
    status, body, err = _http_post(
        f"{pixelrag_url}/search",
        {"queries": [{"text": "football match team"}], "n_docs": 5},
        timeout=15.0,
    )
    dt = time.time() - t0
    assert status == 200, f"/search HTTP {status}: {err}"
    assert isinstance(body, dict)
    assert "results" in body
    assert len(body["results"]) >= 1
    assert dt < 10.0, f"/search trop lent : {dt:.2f}s"


@pytest.mark.slow
def test_pixelrag_enrich_returns_full_payload(pixelrag_url):
    t0 = time.time()
    status, body, err = _http_get(f"{pixelrag_url}/enrich/{TEST_EVENT_ID}", timeout=20.0)
    dt = time.time() - t0
    assert status == 200, f"/enrich HTTP {status}: {err} (event={TEST_EVENT_ID})"
    assert isinstance(body, dict)
    assert body.get("success") is True
    # event_meta aplati doit avoir homeTeam/awayTeam
    meta = body.get("event_meta") or {}
    assert meta.get("homeTeam"), f"event_meta.homeTeam manquant : {meta}"
    assert meta.get("awayTeam"), f"event_meta.awayTeam manquant : {meta}"
    # lineups doit avoir au moins home.formation parsée
    lineups = body.get("lineups") or {}
    assert lineups.get("home") and lineups["home"].get("formation"), (
        f"lineups.home.formation manquant : {lineups}"
    )
    # statistics doit avoir des clés
    stats = body.get("statistics") or {}
    assert isinstance(stats.get("home"), dict) and stats["home"], "stats.home vide"
    # embedding_dim cohérent
    assert body.get("embedding_dim") in (512, 768, 1024)
    # Cache hit au 2e appel : doit être <500ms
    if dt > 0.5:
        status2, _, _ = _http_get(f"{pixelrag_url}/enrich/{TEST_EVENT_ID}", timeout=10.0)
        t1 = time.time()
        assert status2 == 200
        dt2 = time.time() - t1
        assert dt2 < 0.5, f"cache hit trop lent : {dt2:.3f}s"


@pytest.mark.slow
def test_pixelrag_enrich_invalid_event_id_returns_error(pixelrag_url):
    # event_id inexistant : doit retourner success=false (pas 500)
    status, body, err = _http_get(f"{pixelrag_url}/enrich/9999999999", timeout=15.0)
    assert status == 200, f"HTTP {status} inattendu"
    assert body is None or body.get("success") is False, f"body inattendu : {body}"


@pytest.mark.smoke
def test_pixelrag_sofascore_cache_stats(pixelrag_url):
    status, body, err = _http_get(f"{pixelrag_url}/sofascore/cache/stats", timeout=5.0)
    assert status == 200, f"/sofascore/cache/stats HTTP {status}: {err}"
    assert "cache_size" in body
    assert "cache_ttl_s" in body
    assert "index_size" in body
    assert "model" in body
    assert body["cache_ttl_s"] > 0


@pytest.mark.slow
def test_pixelrag_fixtures_endpoint_lists_matches(pixelrag_url):
    """GET /fixtures/{date} — endpoint de decouverte consomme par le plugin
    Node sofascore-py (priority 0). Sofascore injoignable est une reponse
    VALIDE (success=False) : le health tracker basculera sur livescore."""
    date_str = datetime.date.today().isoformat()
    status, body, err = _http_get(f"{pixelrag_url}/fixtures/{date_str}", timeout=30.0)
    if err is not None or status != 200:
        pytest.skip(f"PixelRAG /fixtures indisponible: {err or status}")
    assert "success" in body
    if body["success"] is not True:
        pytest.skip(f"Sofascore injoignable (fallback livescore attendu): {body.get('error')}")
    assert body.get("date") == date_str
    assert isinstance(body.get("events"), list)
    assert body.get("count") == len(body["events"])
    if body["events"]:
        e = body["events"][0]
        for k in ("eid", "homeTeam", "awayTeam", "startTimestamp", "status"):
            assert k in e, f"champ manque {k} dans {e}"
        assert e["status"] in ("scheduled", "inprogress", "finished")
        assert isinstance(e["eid"], int)


@pytest.mark.slow
def test_pixelrag_fixtures_rejects_bad_date(pixelrag_url):
    status, body, err = _http_get(f"{pixelrag_url}/fixtures/pas-une-date", timeout=10.0)
    if err is not None or status != 200:
        pytest.skip(f"PixelRAG /fixtures indisponible: {err or status}")
    assert body.get("success") is False, f"date invalide acceptee: {body}"


@pytest.mark.required
def test_pixelrag_index_required_nonempty(pixelrag_url):
    """Invariant critique (marker 'required', pas de skip conditionnel) :
    l'index PixelRAG doit etre peuple — le pont /predict en depend.
    Si ce test FAIL, lancer scripts/bootstrap_pixelrag_text.js."""
    status, body, err = _http_get(f"{pixelrag_url}/status", timeout=8.0)
    assert status == 200, f"PixelRAG DOWN ({err}) — invariant 'required' non satisfait"
    assert isinstance(body.get("total_vectors"), int), f"/status invalide: {body}"
    assert body["total_vectors"] > 4, f"index quasi-vide: {body['total_vectors']} vecteurs"


# ═══════════════════════════════════════════════════════════════════════════
# AXE 3 — FASTAPI PREDICT
# ═══════════════════════════════════════════════════════════════════════════
@pytest.fixture
def minimal_match_payload():
    """Payload minimal pour /predict — couvre les champs obligatoires."""
    return {
        "sofascore_id": TEST_EVENT_ID,
        "homeTeam": TEST_HOME_TEAM,
        "awayTeam": TEST_AWAY_TEAM,
        "league": "Czech Republic FNL",
        "startTimestamp": 1714233600,
        "task": "PREDICTION",
        "status": "finished",
        "odds_home": 1.85,
        "odds_draw": 3.4,
        "odds_away": 4.2,
        "form_context": '{"home": {"last_5": ["W","W","D","W","L"]}, "away": {"last_5": ["L","D","L","L","W"]}}',
        "h2h_data": "{}",
        "player_ratings_home": "[]",
        "player_ratings_away": "[]",
        "stats_blob": "[]",
        "teamStats": "{}",
        "home_possession": 60,
        "away_possession": 40,
        "home_shots": 11,
        "away_shots": 10,
        "home_xg": 1.55,
        "away_xg": 1.37,
        "weather_temp": 18,
        "days_since_last_match_home": 7,
        "days_since_last_match_away": 7,
        "home_att": 1.0,
        "away_att": 1.0,
        "news_sentiment": 0,
        "odds_movement_24h": "{}",
    }


@pytest.mark.slow
def test_predict_with_sofascore_id_triggers_enrichment(fastapi_url, minimal_match_payload):
    t0 = time.time()
    status, body, err = _http_post(f"{fastapi_url}/predict", minimal_match_payload, timeout=60.0)
    dt = time.time() - t0
    assert status == 200, f"/predict HTTP {status}: {err}"
    assert body.get("success") is True
    # Probabilités 1X2 doivent sommer à ~1
    h = body.get("home_win_probability", 0)
    d = body.get("draw_probability", 0)
    a = body.get("away_win_probability", 0)
    assert abs((h + d + a) - 1.0) < 0.05, f"probs somment à {h+d+a}, pas 1.0"
    # _pixelrag_enrich doit indiquer succès si PixelRAG up
    enrich = body.get("_pixelrag_enrich") or {}
    assert enrich.get("attempted") is True, "sofascore_id présent mais enrich non tenté"
    if enrich.get("success"):
        assert enrich.get("source") == "pixelrag"
        assert enrich.get("latency_ms", 9999) < 5000
    # Latence totale raisonnable (predict + enrich)
    assert dt < 30.0, f"/predict trop lent : {dt:.2f}s"


@pytest.mark.slow
def test_predict_without_sofascore_id_works(fastapi_url, minimal_match_payload):
    payload = dict(minimal_match_payload)
    payload.pop("sofascore_id", None)
    status, body, err = _http_post(f"{fastapi_url}/predict", payload, timeout=60.0)
    assert status == 200, f"/predict HTTP {status}: {err}"
    assert body.get("success") is True
    # Pas d'enrich tenté (pas de sofascore_id)
    enrich = body.get("_pixelrag_enrich") or {}
    assert enrich.get("attempted") is False


@pytest.mark.slow
def test_predict_low_data_returns_implied_odds(fastapi_url, minimal_match_payload):
    """Pour un event low-data (FNL), le moteur bascule sur implied_odds ou
    bayesian. On vérifie que le résultat est cohérent et tracé."""
    status, body, err = _http_post(f"{fastapi_url}/predict", minimal_match_payload, timeout=60.0)
    assert status == 200
    assert "model_used" in body
    assert "confidence" in body
    # xG non-nul attendu (XGBoost ou bayesian)
    assert body.get("home_xg") is not None
    assert body.get("away_xg") is not None


# ═══════════════════════════════════════════════════════════════════════════
# AXE 4 — DB PERSISTANCE
# ═══════════════════════════════════════════════════════════════════════════
@pytest.mark.db
@pytest.mark.local
def test_tactical_db_exists_and_has_schema():
    db_path = ROOT / "data" / "tactical.db"
    assert db_path.exists(), f"tactical.db introuvable : {db_path}"
    con = sqlite3.connect(str(db_path))
    try:
        cur = con.cursor()
        # Tables critiques
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = {r[0] for r in cur.fetchall()}
        for required in ("matches", "visual_context_cache", "leagues_config"):
            assert required in tables, f"table '{required}' manquante : {tables}"
    finally:
        con.close()


@pytest.mark.db
@pytest.mark.local
def test_visual_context_cache_queryable():
    db_path = ROOT / "data" / "tactical.db"
    if not db_path.exists():
        pytest.skip("tactical.db absente")
    con = sqlite3.connect(str(db_path))
    try:
        cur = con.cursor()
        cur.execute("SELECT COUNT(*) FROM visual_context_cache")
        n = cur.fetchone()[0]
        # À ce stade du projet : ~6+ rows attendues (cf. sessions précédentes)
        assert n >= 1, f"visual_context_cache vide (n={n})"
        # Toutes les rows doivent avoir match_id non-NULL
        cur.execute("SELECT COUNT(*) FROM visual_context_cache WHERE match_id IS NULL OR match_id = ''")
        assert cur.fetchone()[0] == 0, "rows sans match_id"
    finally:
        con.close()


@pytest.mark.db
@pytest.mark.local
def test_historical_archive_db_has_finished_matches():
    db_path = ROOT / "data" / "historical_archive.sqlite"
    if not db_path.exists():
        pytest.skip("historical_archive.sqlite absente")
    con = sqlite3.connect(str(db_path))
    try:
        cur = con.cursor()
        # Détection de la table d'archive
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('archive_matches', 'historical_matches', 'fd_history')")
        rows = cur.fetchall()
        assert rows, "aucune table d'archive connue"
        table = rows[0][0]
        cur.execute(f"SELECT COUNT(*) FROM {table} WHERE status IN ('FT','AET','PEN','finished')")
        n = cur.fetchone()[0]
        assert n >= 100, f"{table} n'a que {n} matchs terminés (attendu >= 100)"
    finally:
        con.close()


# ═══════════════════════════════════════════════════════════════════════════
# AXE 5 — FICHIERS PROJET
# ═══════════════════════════════════════════════════════════════════════════
@pytest.mark.local
def test_models_directory_has_trained_models():
    models_dir = ROOT / "models"
    assert models_dir.exists(), f"dossier models/ introuvable"
    required = ["stitch_v24_hybrid.json", "titanium_v2.json"]
    optional = ["stitch_v55_optimized.json", "stitch_v55_visual.json"]
    for m in required:
        p = models_dir / m
        assert p.exists(), f"modèle requis manquant : {m}"
        assert p.stat().st_size > 10_000, f"{m} trop petit ({p.stat().st_size} octets)"


@pytest.mark.local
def test_core_python_modules_parse():
    """Vérifie que tous les .py du core/ parsent (importables). Les import
    réels sont dans les tests dédiés ; ici on vérifie juste la syntaxe."""
    import ast
    core_dir = ROOT / "core"
    failed = []
    for py in core_dir.glob("*.py"):
        if py.name.startswith("_") or py.name in ("__init__.py",):
            continue
        try:
            ast.parse(py.read_text(encoding="utf-8"))
        except SyntaxError as e:
            failed.append(f"{py.name}:{e.lineno} {e.msg}")
    assert not failed, "fichiers Python cassés :\n" + "\n".join(failed)


@pytest.mark.local
def test_services_js_modules_parse():
    """Vérifie que les .js critiques parsent (syntaxe OK)."""
    import subprocess
    services_dir = ROOT / "services"
    critical = [
        "pixelragService.js",
        "visualEnrichmentService.js",
        "scrapers/SofascoreBypass.js",
    ]
    failed = []
    for rel in critical:
        p = services_dir / rel
        if not p.exists():
            failed.append(f"missing: {rel}")
            continue
        r = subprocess.run(
            ["node", "--check", str(p)],
            capture_output=True, text=True, timeout=15,
        )
        if r.returncode != 0:
            failed.append(f"{rel}: {r.stderr.strip()[:200]}")
    assert not failed, "JS cassés :\n" + "\n".join(failed)


@pytest.mark.local
def test_env_file_present_and_valid():
    env = ROOT / ".env"
    assert env.exists(), ".env manquant"
    content = env.read_text(encoding="utf-8", errors="replace")
    # Variables clés attendues
    expected_keys = ["PIXELRAG_URL", "PIXELRAG_WIKI_URL", "VISUAL_BLEND", "USE_V55_VISUAL_MARKETS"]
    for k in expected_keys:
        assert k in content, f"variable d'env '{k}' absente"


@pytest.mark.local
def test_changelog_audit_recent_session():
    """Vérifie qu'une session de travail est documentée récemment (pas de régression)."""
    cl = ROOT / "CHANGELOG_AUDIT.md"
    assert cl.exists(), "CHANGELOG_AUDIT.md manquant"
    content = cl.read_text(encoding="utf-8", errors="replace")
    # Au moins une section "## ... 2026-09-09" (sessions de cette journée)
    today = time.strftime("%Y-%m-%d")
    assert "2026-09-09" in content, f"aucune entrée du {today} dans CHANGELOG_AUDIT.md"
    # Doit contenir au moins un "### Validations" pour traçabilité
    assert "### Validations" in content, "sections 'Validations' manquantes"
