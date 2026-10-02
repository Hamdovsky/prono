"""
test_crawl4ai_service.py — Tests unitaires du service Crawl4AI (:11235).

Ciblent la logique anti-WAF et le contrat HTTP, sans navigateur ni reseau :
on n'importe que les helpers purs (detection de challenge, liste blanche
d'overrides, resolution du mode). Aucun test ne lance Chromium.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

SERVICE_PATH = Path(__file__).resolve().parent.parent / "scripts" / "crawl4ai_service.py"


def _stub_aiohttp_if_missing() -> None:
    """Rend le service importable sans aiohttp (reserve au venv principal).

    aiohttp vit dans requirements-crawl4ai.txt, donc absent du venv CI qui
    execute pytest. On ne teste ici que des fonctions pures : il suffit que les
    symboles utilises a l'import existent, sans comportement.
    """
    try:
        import aiohttp  # noqa: F401

        return
    except ImportError:
        pass

    web = types.ModuleType("aiohttp.web")
    web.middleware = lambda fn: fn
    web.Request = type("Request", (), {})
    web.StreamResponse = type("StreamResponse", (), {})
    web.Application = type("Application", (), {})
    web.json_response = lambda *a, **k: None
    web.run_app = lambda *a, **k: None

    aiohttp = types.ModuleType("aiohttp")
    aiohttp.web = web
    sys.modules["aiohttp"] = aiohttp
    sys.modules["aiohttp.web"] = web


_stub_aiohttp_if_missing()


def _load_service():
    """Charge le service sous un nom dedie (il lance web.run_app au __main__)."""
    name = "crawl4ai_service_under_test"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, SERVICE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


svc = _load_service()


# ── Detection du challenge WAF ───────────────────────────────────────────────


@pytest.mark.parametrize(
    "text",
    [
        "Verifying you are human…",
        "Verifying you are human",
        "Just a moment...",
        "Checking your browser before accessing sofascore.com",
        "Enable JavaScript and cookies to continue",
        "Attention Required! | Cloudflare",
    ],
)
def test_is_challenge_detecte_les_marqueurs_waf(text):
    assert svc.is_challenge(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "Arsenal vs Liverpool\n1X2 2.10 3.40 3.80\nOver/Under 2.5",
        "Manchester City 3 - 1 Brighton",
        "",
        None,
    ],
)
def test_is_challenge_ignore_une_vraie_page(text):
    assert svc.is_challenge(text) is False


def test_is_challenge_ignore_la_majuscule_mais_accepte_melange():
    assert svc.is_challenge("VERIFYING You Are Human") is True


# ── Liste blanche browser_config (requete non fiable) ─────────────────────────


def test_build_browser_overrides_accepte_headless_et_stealth():
    overrides = svc.build_browser_overrides(
        {"browser_config": {"headless": False, "enable_stealth": True, "verbose": False}}
    )
    assert overrides == {"headless": False, "enable_stealth": True, "verbose": False}


@pytest.mark.parametrize("forbidden", ["user_data_dir", "proxy", "cookies", "cdp_url"])
def test_build_browser_overrides_refuse_les_options_dangereuses(forbidden):
    overrides = svc.build_browser_overrides({"browser_config": {forbidden: "x"}})
    assert forbidden not in overrides


def test_build_browser_overrides_ignore_user_agent_pour_eviter_un_relance():
    # Changer d'UA est un argument de lancement : l'accepter ici ferait
    # relancer Chromium a chaque requete.
    overrides = svc.build_browser_overrides({"browser_config": {"user_agent": "Mozilla/5.0 X"}})
    assert overrides == {}


def test_build_browser_overrides_ignore_les_types_invalides():
    assert svc.build_browser_overrides({"browser_config": {"headless": "oui"}}) == {}
    assert svc.build_browser_overrides({"browser_config": "pas un dict"}) == {}
    assert svc.build_browser_overrides({}) == {}


# ── Resolution du mode par requete ───────────────────────────────────────────


def test_resolve_mode_redit_l_environnement_par_defaut():
    assert svc.resolve_mode({}) == (svc.HEADLESS, svc.STEALTH)


def test_resolve_mode_basculera_en_headful_sur_demande():
    headless, _ = svc.resolve_mode({"browser_config": {"headless": False}})
    assert headless is False


# ── Liste blanche crawler_config ──────────────────────────────────────────────


def test_build_run_overrides_borne_les_timings_a_60s():
    overrides = svc.build_run_overrides({"crawler_config": {"page_timeout": 600_000}})
    assert overrides["page_timeout"] == 60_000


def test_build_run_overrides_borne_le_wait_for():
    overrides = svc.build_run_overrides({"crawler_config": {"wait_for": "a" * 5000}})
    assert len(overrides["wait_for"]) == 1000


def test_build_run_overrides_refuse_les_negatifs_et_zero():
    assert svc.build_run_overrides({"crawler_config": {"page_timeout": 0}}) == {}
    assert svc.build_run_overrides({"crawler_config": {"wait_for_timeout": -5}}) == {}


def test_build_run_overrides_garde_locale_et_user_agent():
    overrides = svc.build_run_overrides(
        {"crawler_config": {"user_agent": "UA/1.0", "locale": "en-US", "wait_until": "networkidle"}}
    )
    assert overrides["user_agent"] == "UA/1.0"
    assert overrides["locale"] == "en-US"
    assert overrides["wait_until"] == "networkidle"


def test_build_run_overrides_ignore_les_cles_inconnues():
    overrides = svc.build_run_overrides({"crawler_config": {"javascript_code": "steal()", "verbose": True}})
    assert "javascript_code" not in overrides
    assert overrides["verbose"] is True


# ── Profil persistant et warm-up ─────────────────────────────────────────────


def test_user_data_dir_est_defini_par_defaut():
    assert svc.USER_DATA_DIR
    assert svc.USER_DATA_DIR.endswith(".crawl4ai-profile")


def test_warmup_url_cible_sofascore():
    assert "sofascore.com" in svc.WARMUP_URL


def test_snapshot_expose_profil_et_warmup():
    snapshot = svc.STATE.snapshot()
    for key in ("profile", "profile_active", "warmup_enabled", "warmup_done", "idle_s", "uptime_s"):
        assert key in snapshot


def test_current_mode_reflete_l_environnement_avant_demarrage():
    assert svc.STATE.current_mode() == {"headless": svc.HEADLESS, "stealth": svc.STEALTH}


# ── Serialisation ────────────────────────────────────────────────────────────


class _FakeMarkdown:
    def __init__(self, raw: str) -> None:
        self.raw_markdown = raw
        self.fit_markdown = None


class _FakeResult:
    def __init__(self, *, markdown: str, extracted: str | None, status: int = 200) -> None:
        self.url = "https://www.sofascore.com/event/1/odds"
        self.success = True
        self.status_code = status
        self.error_message = None
        self.markdown = _FakeMarkdown(markdown)
        self.extracted_content = extracted


def test_serialize_result_expose_le_challenge():
    entry = svc._serialize_result(
        _FakeResult(markdown="Verifying you are human…", extracted=None, status=302)
    )
    assert entry["challenge"] is True
    assert entry["status_code"] == 302


def test_serialize_result_parse_le_json():
    entry = svc._serialize_result(
        _FakeResult(markdown="Arsenal 2 - 1 Liverpool", extracted='{"raw_text": "2.10 3.40 3.80"}')
    )
    assert entry["challenge"] is False
    assert entry["extracted"] == {"raw_text": "2.10 3.40 3.80"}


def test_serialize_result_replie_le_json_invalide():
    entry = svc._serialize_result(
        _FakeResult(markdown="Arsenal 2 - 1 Liverpool", extracted="pas du json")
    )
    assert entry["extracted"] is None
    assert entry["extracted_raw"] == "pas du json"


def test_markdown_of_prefere_le_contenu_disponible():
    assert svc.markdown_of(_FakeResult(markdown="hello", extracted=None)) == "hello"
    assert svc.markdown_of(object()) == ""


def test_decode_fenced_json():
    assert svc._decode_fenced_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert svc._decode_fenced_json("pas de bloc") is None
