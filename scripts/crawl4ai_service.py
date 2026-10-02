"""
crawl4ai_service.py — Service HTTP local pour le moteur Crawl4AI (:11235)

Remplace le palier Firecrawl (payant) + Jina Reader (rate-limite 20 req/min)
par un navigateur Chromium self-hosted, gratuit, sur la machine de dev.

Pourquoi un service et pas un appel direct ?
  - Le navigateur est reutilise entre les requetes (cold start ~5 s une fois,
    puis ~1-3 s par page). Sans service, chaque appel Node payerait le cold start.
  - Meme forme que core/visual_server.py (:30002) : un port, un /health, et
    Node parle en HTTP simple.

Pourquoi ce venv est separe du venv principal ?
  - requirements-crawl4ai.txt n'est reference par AUCUN Dockerfile.
  -> Playwright + Chromium n'entrent jamais dans les images Render/Fly.io
     (contrainte AGENTS.md : "No Chromium/Puppeteer in Docker image").
  - Le venv principal (.venv) reste intact : curl_cffi, soccerdata, xgboost...

Endpoints
  GET  /health      -> statut, version, navigateur vivant, uptime
  POST /md          -> markdown  (remplace r.jina.ai)
  POST /crawl       -> extraction structuree CSS/XPath/regex, synchrone, 0 cout
  POST /llm-extract -> extraction structuree par LLM, synchrone (in-process)

Note sur /llm-extract : le serveur Docker officiel expose l'extraction LLM via
`POST /llm/job` (202 Accepted + polling), donc asynchrone, ce qui introduirait
de la latence dans un contrat `getOdds()` synchrone cote Node. En in-process on
peut l'appeler directement via LLMExtractionStrategy, donc SYNCHRONE. C'est un
avantage net du backend local sur le backend Docker.

Lancement :
    .venv-crawl4ai\\Scripts\\python scripts/crawl4ai_service.py
    .venv-crawl4ai\\Scripts\\python scripts/crawl4ai_service.py --port 11235 --verbose
    .venv-crawl4ai\\Scripts\\python scripts/crawl4ai_service.py --headful

Anti-WAF Sofascore :
    Blocage constate au niveau IP, pas un challenge resoluble : la page de
    verification est statique (ni cf_clearance, ni auto-resolution JS, ni en
    headful). Voir CHANGELOG_AUDIT.md. Le service reste en place comme palier
    de secours propre : il signale `challenge: true` et laisse la chaine
    continuer vers bypass/firecrawl/jina.
    Contre-mesures conservees (utiles des une IP non bloquee) :
      - profil Chromium persistant (CRAWL4AI_USER_DATA_DIR) ;
      - warm-up sur l'accueil avant la page cible (CRAWL4AI_WARMUP) ;
      - UA Chrome recent (CRAWL4AI_USER_AGENT) ;
      - mode visible : --headful ou CRAWL4AI_HEADLESS=0, ou par requete via
        `browser_config: { headless: false }`.

Sonde de sante :
    node scripts/crawl4ai_health.js
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import random
import sys
import time
from pathlib import Path
from typing import Any

from aiohttp import web

PROJECT_ROOT = Path(__file__).resolve().parent.parent

logger = logging.getLogger("crawl4ai_service")

# ── Configuration (surchargeable par variables d'environnement) ──────────────

HOST = os.environ.get("CRAWL4AI_HOST", "127.0.0.1")
PORT = int(os.environ.get("CRAWL4AI_PORT", "11235"))

# Concurrence basse : la machine de dev a ~1 Go libre, chaque page Chromium
# headless consomme 300-600 Mo. Ne pas monter au-dela sans mesurer.
CONCURRENCY = int(os.environ.get("CRAWL4AI_CONCURRENCY", "2"))

# Discipline de politesse : meme cadence que le client theAnalyst (E69)
# (1500 ms + jitter 40 %). Un crawlerbrowser agressif se fait bannir IP,
# ce qui casserait les paliers curl_cffi qui partagent la meme sortie.
MIN_INTERVAL_MS = int(os.environ.get("CRAWL4AI_MIN_INTERVAL_MS", "1500"))
JITTER_RATIO = float(os.environ.get("CRAWL4AI_JITTER_RATIO", "0.4"))

# Arret automatique du navigateur apres inactivite, pour liberer la RAM.
IDLE_TIMEOUT_S = int(os.environ.get("CRAWL4AI_IDLE_TIMEOUT_S", "900"))

# Auth facultative. Inactive par defaut car on binde sur 127.0.0.1 (localhost).
# A activer des que le service est expose sur 0.0.0.0.
API_TOKEN = os.environ.get("CRAWL4AI_API_TOKEN", "").strip()

HEADLESS = os.environ.get("CRAWL4AI_HEADLESS", "1").strip().lower() not in ("0", "false", "no")
STEALTH = os.environ.get("CRAWL4AI_STEALTH", "on").strip().lower() in ("1", "on", "true", "yes")

PAGE_TIMEOUT_MS = int(os.environ.get("CRAWL4AI_PAGE_TIMEOUT_MS", "45000"))

# ── Anti-WAF Sofascore ───────────────────────────────────────────────────────
# CONSTAT MESURE (2026-09-30, voir CHANGELOG_AUDIT.md) : le blocage Sofascore
# n'est PAS un challenge Cloudflare resoluble. La page de verification est
# statique : ni `cf_clearance`, ni auto-resolution JS, ni en headless, ni en
# headful, ni apres 40 s d'attente. C'est un blocage au niveau de l'IP.
#
# Ce qui suit est donc de l'hygiene et non une solution constatee ; c'est utile
# des que la machine scrape depuis une IP non bloquee :
#   - profil Chromium persistant (CRAWL4AI_USER_DATA_DIR) pour conserver le
#     cookie de defi d'un crawl a l'autre (INERTE sur crawl4ai 0.9.4, qui
#     ignore user_data_dir — voir CrawlerState._report_profile) ;
#   - warm-up sur l'accueil avant la page cible (CRAWL4AI_WARMUP) ;
#   - UA Chrome recent (CRAWL4AI_USER_AGENT) ;
#   - mode visible : --headful ou CRAWL4AI_HEADLESS=0, ou par requete via
#     `browser_config: { headless: false }` (relance interne du navigateur).
# Chaque reponse porte un booleen `challenge` pour que Node sache qu'il n'a
# pas scrape une vraie page, sans avoir a detecter la chaine lui-meme.

USER_DATA_DIR = os.environ.get("CRAWL4AI_USER_DATA_DIR", "").strip() or str(
    PROJECT_ROOT / ".crawl4ai-profile"
)

# Si le challenge persiste malgre le profil, on peut forcer le mode visible.
# headless est un argument de LANCEMENT : le changer necessite de relancer le
# service (--headful) ou de passer headless:false par requete (relance interne).
USER_AGENT = os.environ.get("CRAWL4AI_USER_AGENT", "").strip() or (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

WARMUP_ENABLED = os.environ.get("CRAWL4AI_WARMUP", "on").strip().lower() in ("1", "on", "true", "yes")
WARMUP_URL = os.environ.get("CRAWL4AI_WARMUP_URL", "https://www.sofascore.com/").strip()
WARMUP_SETTLE_MS = int(os.environ.get("CRAWL4AI_WARMUP_SETTLE_MS", "2500"))

# Marqueurs de challenge WAF, detectes COTE SERVICE pour renvoyer un booleen
# `challenge` a Node plutot que de lui faire deviner avec une page de 200 Ko.
CHALLENGE_MARKERS = (
    "verifying you are human",
    "just a moment",
    "checking your browser",
    "enable javascript and cookies to continue",
    "attention required! | cloudflare",
)

# Provider LLM par defaut. OpenRouter car OPENROUTER_API_KEY est deja dans .env.
DEFAULT_LLM_PROVIDER = os.environ.get("CRAWL4AI_LLM_PROVIDER", "openrouter/openai/gpt-4o-mini")

# Fenetres autorisees pour `f` (crawl4ai 0.9.x). `f` est un FILTRE de contenu,
# pas un format de sortie : envoyer "html" ou "markdown" donne un HTTP 422.
VALID_FILTERS = ("raw", "fit", "bm25", "llm")


def is_challenge(text: Any) -> bool:
    """Vrai si le contenu recupere est une page de verification anti-bot."""
    if not text:
        return False
    lowered = str(text)[:4000].lower()
    return any(marker in lowered for marker in CHALLENGE_MARKERS)


# ── Etat global ──────────────────────────────────────────────────────────────


class CrawlerState:
    """Navigateur partage + semaphore + limiteur de cadence.

    Le navigateur est demarre paresseusement (au premier scrape) pour que
    /health reponde immediatement au demarrage du process.

    Le mode (headless, stealth) est pilotable PAR REQUETE. Comme ce sont des
    arguments de lancement Chromium, un changement de mode entails un
    redemarrage du navigateur (~5 s) — on le fait uniquement quand la requete
    demande vraiment autre chose, et le warm-up est rejoue apres.
    """

    def __init__(self) -> None:
        self._crawler: Any = None
        self._browser_lock = asyncio.Lock()
        self._semaphore: asyncio.Semaphore | None = None
        self._rate_lock = asyncio.Lock()
        self._last_request_ts: float = 0.0
        self._last_activity_ts: float = time.time()
        self._version: str = "unknown"
        self._requests: int = 0
        self._errors: int = 0
        self._mode: tuple[bool, bool] | None = None
        self._warmup_done: bool = False
        self._warmup_ts: float = 0.0
        self._profile_reported: bool = False

    async def start(self) -> None:
        """Demarre le navigateur dans le mode configure par l'environnement."""
        await self.ensure_browser(HEADLESS, STEALTH)

    async def ensure_browser(self, headless: bool, stealth: bool) -> None:
        """Garantit un navigateur vivant dans le mode demande.

        Redemarre uniquement si le mode demande differe du mode courant.
        """
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(CONCURRENCY)
        if self._crawler is not None and self._mode == (headless, stealth):
            return

        async with self._browser_lock:
            if self._crawler is not None and self._mode == (headless, stealth):
                return
            if self._crawler is not None:
                # Changement de mode demande : on ferme l'ancien navigateur.
                await self._shutdown_locked()

            # Import tardif : evite de charger Playwright au demarrage du module,
            # et surface les erreurs d'installation ici plutot qu'a l'import.
            from crawl4ai import AsyncWebCrawler, BrowserConfig

            try:
                from crawl4ai.__version__ import __version__ as c4a_version
            except Exception:  # pragma: no cover - format de version variable
                c4a_version = "unknown"
            self._version = str(c4a_version)

            logger.info(
                "Demarrage Chromium (headless=%s, stealth=%s, profil=%s, version=%s)",
                headless,
                stealth,
                USER_DATA_DIR,
                self._version,
            )
            self._crawler = await self._launch(headless, stealth, AsyncWebCrawler, BrowserConfig)
            self._mode = (headless, stealth)
            self._warmup_done = False
            self._last_activity_ts = time.time()

    async def _launch(self, headless: bool, stealth: bool, AsyncWebCrawler: Any, BrowserConfig: Any) -> Any:
        """Lance le crawler, avec repli si user_data_dir n'est pas supporte.

        ATTENTION - verifie sur crawl4ai 0.9.4 : `BrowserConfig.user_data_dir` est
        ACCEPTE sans erreur mais IGNORE (le repertoire n'est jamais cree). Le
        profil persistant ne fonctionne donc pas sur cette version ; le code le
        passe quand meme parce qu'il devient actif sur les versions ou le
        suport existe, et `_report_profile` previent si le levier reste inerte.

        Chaque repli retire une option de lancement, pas le navigateur entier :
        un demarrage sans profil vaut mieux qu'un service qui ne demarre pas.
        """
        base = {"headless": headless, "enable_stealth": stealth, "verbose": False}
        attempts = (
            dict(base, user_data_dir=USER_DATA_DIR, user_agent=USER_AGENT),
            dict(base, user_data_dir=USER_DATA_DIR),
            dict(base, user_agent=USER_AGENT),
            base,
        )
        last_error: Exception | None = None
        for index, kwargs in enumerate(attempts):
            try:
                crawler = AsyncWebCrawler(config=BrowserConfig(**kwargs))
                await crawler.__aenter__()
                if index > 0:
                    logger.warning(
                        "Option de lancement incompatible (tentative %s sans %s)",
                        index + 1,
                        ", ".join(sorted(set(base) ^ set(kwargs))) or "?",
                    )
                self._report_profile()
                return crawler
            except TypeError as exc:
                # Option non supportee par cette version de crawl4ai.
                last_error = exc
                continue
            except Exception as exc:
                last_error = exc
                break
        raise RuntimeError(f"Demarrage Chromium impossible: {last_error}")

    def _report_profile(self) -> None:
        """Alerte si le profil persistant demande n'a pas ete cree.

        Evite de croire que le levier anti-WAF est actif alors qu'il est inerte.
        """
        if os.path.isdir(USER_DATA_DIR):
            self._profile_reported = True
            return
        if self._profile_reported:
            return
        self._profile_reported = True
        logger.warning(
            "Profil persistant INACTIF : %s n'a pas ete cree par crawl4ai %s. "
            "Cette version ignore BrowserConfig.user_data_dir, donc les cookies "
            "du challenge WAF ne sont pas conserves d'un crawl a l'autre. "
            "Le blocage Sofascore observe est de toute facon au niveau IP.",
            USER_DATA_DIR,
            self._version,
        )

    async def _shutdown_locked(self) -> None:
        crawler, self._crawler = self._crawler, None
        self._mode = None
        self._warmup_done = False
        if crawler is not None:
            try:
                await crawler.__aexit__(None, None, None)
            except Exception as exc:  # pragma: no cover - arret best-effort
                logger.warning("Arret du navigateur incomplet: %s", exc)

    async def warmup(self) -> None:
        """Visite l'accueil du site cible une fois par session navigateur.

        But anti-WAF : le challenge se resout tout seul si le navigateur a une
        histoire (cookie de defi + profil). On n'extrait rien, on attend juste
        que la page se stabilise.
        """
        if not WARMUP_ENABLED or self._crawler is None or self._warmup_done:
            return
        async with self._browser_lock:
            if self._crawler is None or self._warmup_done:
                return
            logger.info("Warm-up anti-WAF sur %s", WARMUP_URL)
            try:
                from crawl4ai import CrawlerRunConfig

                await self._crawler.arun(
                    url=WARMUP_URL,
                    config=CrawlerRunConfig(
                        cache_mode="bypass",
                        page_timeout=PAGE_TIMEOUT_MS,
                        wait_until="domcontentloaded",
                    ),
                )
            except Exception as exc:
                logger.warning("Warm-up echoue (non bloquant): %s", exc)
            await asyncio.sleep(WARMUP_SETTLE_MS / 1000.0)
            self._warmup_done = True
            self._warmup_ts = time.time()

    async def stop(self) -> None:
        if self._crawler is None:
            return
        async with self._browser_lock:
            await self._shutdown_locked()

    async def throttle(self) -> None:
        """Espace les requetes sortantes (politesse anti-blocage IP)."""
        async with self._rate_lock:
            target = MIN_INTERVAL_MS / 1000.0
            jitter = target * JITTER_RATIO * random.random()
            gap = target + jitter - (time.time() - self._last_request_ts)
            if gap > 0:
                await asyncio.sleep(gap)
            self._last_request_ts = time.time()

    def touch(self) -> None:
        self._last_activity_ts = time.time()
        self._requests += 1

    def fail(self) -> None:
        self._last_activity_ts = time.time()
        self._errors += 1

    def idle_seconds(self) -> float:
        return time.time() - self._last_activity_ts

    def request_count(self) -> int:
        return self._requests

    def browser_alive(self) -> bool:
        return self._crawler is not None

    def warmup_done(self) -> bool:
        return self._warmup_done

    def current_mode(self) -> dict[str, Any]:
        headless, stealth = self._mode if self._mode else (HEADLESS, STEALTH)
        return {"headless": headless, "stealth": stealth}

    def snapshot(self) -> dict[str, Any]:
        return {
            "browser_alive": self.browser_alive(),
            "version": self._version,
            "requests": self._requests,
            "errors": self._errors,
            "uptime_s": round(time.time() - _START_TS, 1),
            "idle_s": round(self.idle_seconds(), 1),
            "profile": USER_DATA_DIR,
            "profile_active": os.path.isdir(USER_DATA_DIR),
            "warmup_enabled": WARMUP_ENABLED,
            "warmup_done": self._warmup_done,
            "warmup_s": round(time.time() - self._warmup_ts, 1) if self._warmup_ts else None,
        }


STATE = CrawlerState()
_START_TS = time.time()


# ── Helpers ─────────────────────────────────────────────────────────────────


def load_project_env() -> None:
    """Charge le .env du projet pour OPENROUTER_API_KEY etc.

    Lit uniquement les cles manquantes : l'environnement du process gagne
    toujours, ce qui evite d'ecraser une variable injectee par le lanceur.
    """
    env_file = PROJECT_ROOT / ".env"
    if not env_file.exists():
        return
    try:
        for raw_line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ and value:
                os.environ[key] = value
    except Exception as exc:  # pragma: no cover - lecture best-effort
        logger.warning("Lecture de .env impossible: %s", exc)


def markdown_of(result: Any) -> str:
    """Extrait le markdown d'un CrawlResult quelle que soit sa version.

    0.9.x expose un CrawlResultContainer qui delegue au premier resultat ;
    les versions precedentes renvoyaient le CrawlResult directement.
    """
    md = getattr(result, "markdown", None)
    if md is None:
        return ""
    if isinstance(md, str):
        return md
    fit = getattr(md, "fit_markdown", None)
    if fit:
        return fit
    raw = getattr(md, "raw_markdown", None)
    if raw:
        return raw
    return str(md)


def build_browser_overrides(payload: dict[str, Any]) -> dict[str, Any]:
    """Overrides navigateur acceptables depuis une requete non fiable.

    Meme contrainte que le serveur Docker officiel : `proxy`, `user_data_dir`,
    `cookies`, `cdp_url` sont INTERDITS. On n'accepte que la liste blanche
    ci-dessous, le reste est ignore silencieusement.

    `headless` est accepte ici (et pas seulement via CRAWL4AI_HEADLESS au boot)
    pour pouvoir basculer en mode visible sans redemarrer le service. C'est un
    argument de lancement Chromium : CrawlerState.ensure_browser() relance donc
    le navigateur quand le mode demande change.

    `user_agent` n'est PAS accepte ici : changer d'UA au lancement ferait
    relancer le navigateur a chaque requete. Il se regle par
    CRAWL4AI_USER_AGENT au demarrage, ou par requete au niveau CrawlerRunConfig.
    """
    overrides: dict[str, Any] = {}
    incoming = payload.get("browser_config")
    if not isinstance(incoming, dict):
        return overrides
    if "enable_stealth" in incoming and isinstance(incoming["enable_stealth"], bool):
        overrides["enable_stealth"] = incoming["enable_stealth"]
    if "headless" in incoming and isinstance(incoming["headless"], bool):
        overrides["headless"] = incoming["headless"]
    if isinstance(incoming.get("verbose"), bool):
        overrides["verbose"] = incoming["verbose"]
    return overrides


def resolve_mode(payload: dict[str, Any]) -> tuple[bool, bool]:
    """Mode (headless, stealth) a appliquer pour cette requete."""
    overrides = build_browser_overrides(payload)
    headless = bool(overrides.get("headless", HEADLESS))
    stealth = bool(overrides.get("enable_stealth", STEALTH))
    return headless, stealth


async def prepare_browser(payload: dict[str, Any]) -> None:
    """Navigateur dans le mode demande + warm-up anti-WAF (une fois par session)."""
    await STATE.ensure_browser(*resolve_mode(payload))
    if STATE._semaphore is None:  # pragma: no cover - defensive
        STATE._semaphore = asyncio.Semaphore(CONCURRENCY)
    await STATE.warmup()


def build_run_overrides(payload: dict[str, Any]) -> dict[str, Any]:
    """Overrides CrawlerRunConfig acceptables (meme liste blanche que Docker)."""
    overrides: dict[str, Any] = {}
    incoming = payload.get("crawler_config")
    if not isinstance(incoming, dict):
        return overrides

    for key in ("wait_for", "wait_until", "css_selector", "excluded_selector",
                "excluded_tags", "user_agent", "locale"):
        value = incoming.get(key)
        if isinstance(value, str) and value:
            overrides[key] = value[:1000]

    for key in ("scan_full_page", "only_text", "verbose", "check_robots_txt"):
        if isinstance(incoming.get(key), bool):
            overrides[key] = incoming[key]

    for key in ("page_timeout", "wait_for_timeout", "scroll_delay", "max_scroll_steps"):
        value = incoming.get(key)
        if isinstance(value, (int, float)) and value > 0:
            # Bornes identiques au serveur : 60 s max, evite qu'une requete
            # bloque un des 2 slots de concurrence pendant 10 minutes.
            overrides[key] = min(value, 60_000)

    return overrides


def error_response(message: str, status: int = 400) -> web.Response:
    return web.json_response({"success": False, "error": message}, status=status)


@web.middleware
async def auth_middleware(request: web.Request, handler: Any) -> web.StreamResponse:
    """Garde l'API quand CRAWL4AI_API_TOKEN est renseigne (defaut: desactive)."""
    if API_TOKEN and request.path != "/health":
        header = request.headers.get("Authorization", "")
        if not header.lower().startswith("bearer ") or header[7:].strip() != API_TOKEN:
            return error_response("Authentication required", status=401)
    return await handler(request)


# ── Endpoints ────────────────────────────────────────────────────────────────


async def handle_health(request: web.Request) -> web.Response:
    payload = STATE.snapshot()
    payload["status"] = "ok"
    payload.update(STATE.current_mode())
    payload["concurrency"] = CONCURRENCY
    payload["warmup_url"] = WARMUP_URL
    return web.json_response(payload)


async def handle_md(request: web.Request) -> web.Response:
    """URL -> markdown. Remplace r.jina.ai (pas de rate limit, self-hosted)."""
    try:
        payload = await request.json()
    except Exception:
        return error_response("Corps JSON invalide")

    url = payload.get("url")
    if not isinstance(url, str) or not url:
        return error_response("Champ 'url' requis")

    filter_type = payload.get("f") or "fit"
    if filter_type not in VALID_FILTERS:
        return error_response(
            f"Filtre invalide '{filter_type}'. Attendu parmi {VALID_FILTERS} "
            "(c'est un filtre de contenu, pas un format de sortie)"
        )

    query = payload.get("q") if isinstance(payload.get("q"), str) else None

    await prepare_browser(payload)

    from crawl4ai import CrawlerRunConfig

    async with STATE._semaphore:
        await STATE.throttle()
        started = time.time()
        try:
            result = await STATE._crawler.arun(
                url=url,
                config=CrawlerRunConfig(
                    cache_mode=payload.get("c", "0"),
                    page_timeout=PAGE_TIMEOUT_MS,
                    **build_run_overrides(payload),
                ),
            )
        except Exception as exc:
            STATE.fail()
            logger.warning("echec /md %s: %s", url, exc)
            return error_response(f"Crawl echoue: {exc}", status=502)

    elapsed_ms = int((time.time() - started) * 1000)
    STATE.touch()

    if not getattr(result, "success", False):
        STATE.fail()
        detail = getattr(result, "error_message", None) or "raison inconnue"
        return error_response(f"Crawl non valide: {detail}", status=502)

    markdown = markdown_of(result)
    return web.json_response(
        {
            "success": True,
            "url": url,
            "filter": filter_type,
            "query": query,
            "markdown": markdown,
            "status_code": getattr(result, "status_code", None),
            "challenge": is_challenge(markdown),
            "elapsed_ms": elapsed_ms,
        }
    )


def _make_css_strategy(schema: dict[str, Any]) -> Any:
    """Construit une JsonCssExtractionStrategy depuis un schema JSON nu.

    L'API REST de crawl4ai attend `{type, params:{schema}}` ; ici on est
    in-process, donc on prend le schema nu. Note : en 0.9.4 la classe est
    exportee au top-level `crawl4ai` (et dans `crawl4ai.extraction_strategy`),
    PAS dans `crawl4ai.content_filter_strategy`.
    """
    try:
        from crawl4ai import JsonCssExtractionStrategy
    except ImportError:  # pragma: no cover - versions anterieures
        from crawl4ai.extraction_strategy import JsonCssExtractionStrategy

    return JsonCssExtractionStrategy(schema)


async def handle_crawl(request: web.Request) -> web.Response:
    """Extraction structuree CSS/XPath/regex — synchrone, sans LLM, 0 cout.

    C'est le chemin chaud du pipeline : pas de polling, pas de quota.
    Une strategie de type `JsonCssExtractionStrategy` est reconstruite depuis
    `extraction_strategy.params.schema` ; un schema nu est aussi accepte.
    """
    try:
        payload = await request.json()
    except Exception:
        return error_response("Corps JSON invalide")

    urls = payload.get("urls")
    if not isinstance(urls, list) or not urls:
        return error_response("Champ 'urls' (liste non vide) requis")
    urls = [u for u in urls if isinstance(u, str) and u][:100]

    strategy_spec = payload.get("extraction_strategy") or (
        payload.get("crawler_config") or {}
    ).get("extraction_strategy")

    extraction_strategy = None
    if isinstance(strategy_spec, dict):
        raw_schema = strategy_spec.get("schema")
        if raw_schema is None and isinstance(strategy_spec.get("params"), dict):
            raw_schema = strategy_spec["params"].get("schema")
        if isinstance(raw_schema, dict) and raw_schema:
            try:
                extraction_strategy = _make_css_strategy(raw_schema)
            except Exception as exc:
                return error_response(f"Schema CSS invalide: {exc}")

    await prepare_browser(payload)

    from crawl4ai import CrawlerRunConfig

    overrides = build_run_overrides(payload)
    started = time.time()

    async with STATE._semaphore:
        await STATE.throttle()
        try:
            container = await STATE._crawler.arun_many(
                urls=urls,
                config=CrawlerRunConfig(
                    cache_mode="0",
                    page_timeout=PAGE_TIMEOUT_MS,
                    extraction_strategy=extraction_strategy,
                    **overrides,
                ),
            )
        except Exception as exc:
            STATE.fail()
            logger.warning("echec /crawl: %s", exc)
            return error_response(f"Crawl echoue: {exc}", status=502)

    results: list[dict[str, Any]] = []
    try:
        iterator = container.__aiter__()
        while True:
            try:
                item = await iterator.__anext__()
            except StopAsyncIteration:
                break
            results.append(_serialize_result(item))
    except AttributeError:
        for item in container:  # conteneur synchrone selon la version
            results.append(_serialize_result(item))

    STATE.touch()
    return web.json_response(
        {
            "success": True,
            "results": results,
            "elapsed_ms": int((time.time() - started) * 1000),
        }
    )


def _serialize_result(result: Any) -> dict[str, Any]:
    """Serialise un CrawlResult pour Node.

    `extracted_content` est une CHAINE JSON cote crawl4ai : on la parse pour
    eviter un double json.loads cote Node.

    `challenge` vaut True quand la page recuperee est une verification anti-bot.
    On le calcule ici, sur le markdown, plutot que de renvoyer 200 Ko de HTML a
    Node pour qu'il y cherche une chaine : le WAF est une information de premier
    plan, pas une erreur de scraping.
    """
    entry: dict[str, Any] = {
        "url": getattr(result, "url", None),
        "success": bool(getattr(result, "success", False)),
        "status_code": getattr(result, "status_code", None),
        "error_message": getattr(result, "error_message", None),
        "challenge": is_challenge(markdown_of(result)),
    }
    extracted = getattr(result, "extracted_content", None)
    if extracted:
        try:
            entry["extracted"] = json.loads(extracted)
        except (TypeError, ValueError):
            entry["extracted"] = None
            entry["extracted_raw"] = extracted[:20000]
    return entry


async def handle_llm_extract(request: web.Request) -> web.Response:
    """Extraction structuree par LLM — SYNCHRONE (in-process, pas de /llm/job).

    Remplace FirecrawlScraper.js. Meme schema JSON que ODDS_SCHEMA, mais
    l'appel est direct : pas de 202 Accepted, pas de polling, donc pas de
    latence ajoutee au contrat synchrone `getOdds()`.
    """
    try:
        payload = await request.json()
    except Exception:
        return error_response("Corps JSON invalide")

    url = payload.get("url")
    if not isinstance(url, str) or not url:
        return error_response("Champ 'url' requis")

    instruction = payload.get("q") or payload.get("instruction")
    if not isinstance(instruction, str) or not instruction.strip():
        return error_response("Champ 'q' (instruction) requis")

    schema = payload.get("schema")
    if isinstance(schema, str):
        try:
            schema = json.loads(schema)
        except ValueError as exc:
            return error_response(f"Champ 'schema' JSON invalide: {exc}")
    if not isinstance(schema, dict) or not schema:
        return error_response("Champ 'schema' (objet JSON) requis")

    provider = payload.get("provider") or DEFAULT_LLM_PROVIDER
    temperature = payload.get("temperature")
    if not isinstance(temperature, (int, float)):
        temperature = 0.1

    try:
        from crawl4ai import LLMConfig, LLMExtractionStrategy
    except Exception as exc:  # pragma: no cover - dependance optionnelle
        return error_response(f"Extraction LLM indisponible: {exc}", status=503)

    llm_config = LLMConfig(provider=provider, temperature=float(temperature))
    strategy = LLMExtractionStrategy(
        llm_config=llm_config,
        schema=schema,
        extraction_type="schema",
        instruction=instruction,
    )

    await prepare_browser(payload)

    from crawl4ai import CrawlerRunConfig

    async with STATE._semaphore:
        await STATE.throttle()
        started = time.time()
        try:
            result = await STATE._crawler.arun(
                url=url,
                config=CrawlerRunConfig(
                    cache_mode="0",
                    page_timeout=PAGE_TIMEOUT_MS,
                    extraction_strategy=strategy,
                    **build_run_overrides(payload),
                ),
            )
        except Exception as exc:
            STATE.fail()
            logger.warning("echec /llm-extract %s: %s", url, exc)
            return error_response(f"Extraction LLM echouee: {exc}", status=502)

    STATE.touch()

    if not getattr(result, "success", False):
        STATE.fail()
        detail = getattr(result, "error_message", None) or "raison inconnue"
        return error_response(f"Extraction LLM non valide: {detail}", status=502)

    extracted = getattr(result, "extracted_content", None)
    parsed: Any = None
    if extracted:
        try:
            parsed = json.loads(extracted)
        except (TypeError, ValueError):
            # Certains providers renvoient du markdown : on tente dedecoder
            # un eventuel bloc ```json avant d'abandonner.
            parsed = _decode_fenced_json(str(extracted))

    markdown = markdown_of(result)
    return web.json_response(
        {
            "success": True,
            "url": url,
            "result": parsed,
            "provider": provider,
            "challenge": is_challenge(markdown),
            "elapsed_ms": int((time.time() - started) * 1000),
        }
    )


def _decode_fenced_json(raw: str) -> Any:
    """Recupere un objet JSON entoure d'un bloc ```json ... ```."""
    try:
        if "```" not in raw:
            return None
        block = raw.split("```", 2)[1]
        if block.lower().startswith("json"):
            block = block[4:]
        return json.loads(block.strip())
    except Exception:
        return None


# ── Surveillance d'inactivite ────────────────────────────────────────────────


async def idle_watchdog(app: web.Application) -> None:
    if IDLE_TIMEOUT_S <= 0:
        return
    try:
        while True:
            await asyncio.sleep(30)
            if STATE.request_count() > 0 and STATE.idle_seconds() > IDLE_TIMEOUT_S:
                logger.info(
                    "Inactivite > %ss, arret du service (relancer avec "
                    "scripts/crawl4ai_service.py)",
                    IDLE_TIMEOUT_S,
                )
                await app.shutdown()
                return
    except asyncio.CancelledError:  # pragma: no cover - arret du process
        raise


# ── Point d'entree ───────────────────────────────────────────────────────────


async def on_startup(app: web.Application) -> None:
    """Log explicite : sans lui, `print=None` rend le demarrage invisible.

    Distingue deux pannes tres differentes qui se ressemblent cote client :
    process lance mais socket non binde (connexion refusee), vs service absent.
    """
    logger.info("Service a l'ecoute sur http://%s:%s", app["host"], app["port"])
    asyncio.ensure_future(idle_watchdog(app))


def build_app(host: str = HOST, port: int = PORT) -> web.Application:
    app = web.Application(middlewares=[auth_middleware], client_max_size=16 * 1024 * 1024)
    app["host"] = host
    app["port"] = port
    app.router.add_get("/health", handle_health)
    app.router.add_post("/md", handle_md)
    app.router.add_post("/crawl", handle_crawl)
    app.router.add_post("/llm-extract", handle_llm_extract)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(lambda _app: STATE.stop())
    return app


def main() -> int:
    parser = argparse.ArgumentParser(description="Service Crawl4AI local (:11235)")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument(
        "--headful",
        action="store_true",
        help="Ouvre un Chromium VISIBLE (mode anti-WAF le plus efficace, mais fenetre ouverte)",
    )
    parser.add_argument(
        "--no-warmup",
        action="store_true",
        help="Desactive la visite d'accueil anti-WAF avant chaque session navigateur",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    global HEADLESS, WARMUP_ENABLED
    if args.headful:
        HEADLESS = False
    if args.no_warmup:
        WARMUP_ENABLED = False

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [crawl4ai] %(levelname)s %(message)s",
    )

    load_project_env()

    logger.info(
        "Configuration: %s:%s | concurrence=%s | headless=%s | stealth=%s | "
        "profil=%s | warmup=%s | min_interval=%sms | idle_timeout=%ss",
        args.host,
        args.port,
        CONCURRENCY,
        HEADLESS,
        STEALTH,
        USER_DATA_DIR,
        "on" if WARMUP_ENABLED else "off",
        MIN_INTERVAL_MS,
        IDLE_TIMEOUT_S,
    )
    if API_TOKEN:
        logger.info("Auth activee (CRAWL4AI_API_TOKEN renseigne)")
    else:
        logger.warning(
            "Sans CRAWL4AI_API_TOKEN : aucune authentification. Acceptable sur "
            "127.0.0.1, a rendre obligatoire avant toute exposition reseau."
        )

    try:
        web.run_app(build_app(args.host, args.port), host=args.host, port=args.port, print=None)
    except KeyboardInterrupt:  # pragma: no cover - arret manuel
        logger.info("Arret manuel")
    return 0


if __name__ == "__main__":
    sys.exit(main())
