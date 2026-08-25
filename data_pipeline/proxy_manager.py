"""Gestion des proxies libres avec fallback & rotation automatique.

Comportement par défaut : aucune requête ne passe par un proxy (vitesse max).
À la détection d'une réponse bloquante (403/429/503) ou d'une erreur réseau
(ECONNRESET/ETIMEDOUT), on bascule automatiquement sur la liste de proxies :
  1. la liste est rafraîchie en mémoire (cache ~30 min, sources configurées) ;
  2. le proxy suivant est testé (health-check court ~3 s) ;
  3. le proxy est marqué "bad" et exclu s'il échoue ;
  4. la requête est retentée jusqu'à ``PROXY_MAX_ATTEMPTS`` proxies distincts.

Les proxies sont des données publiques volatiles : on ne leur envoie jamais de
credentials ni de données personnelles, uniquement des requêtes HTTPS ordinaires.

Export principal : :func:`fetch_with_proxy` (requête directe d'abord, puis
rotation) et :class:`ProxyManager` (moteur, injectable dans les tests).
"""
from __future__ import annotations

import re
import threading
import time

import requests

from config import (
    PROXY_FETCH_TIMEOUT, PROXY_HEALTH_TIMEOUT, PROXY_MAX_ATTEMPTS,
    PROXY_REFRESH_MIN, PROXY_RETRY_STATUS, PROXY_SOURCES,
)
from util import get_logger

log = get_logger("proxy")

# Erreurs réseau qui déclenchent la rotation (codes erreur requests/urllib)
NETWORK_ERRCODES = {"ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"}


def _valid_port(port: str) -> bool:
    return port.isdigit() and 0 < int(port) <= 65535


PROXY_LINE_RE = re.compile(r"^[^:/\s]+:\d{1,5}$")


class ProxyManager:
    """Cache en mémoire de proxies actifs + round-robin + blacklist des bad.

    Thread-safe (les scrapers tournent dans des workers). Les listes sont
    re-téléchargées au plus tous les ``refresh_min`` minutes.
    """

    def __init__(self, sources: list[str] | None = None, refresh_min: float = PROXY_REFRESH_MIN,
                 fetch_timeout: float = PROXY_FETCH_TIMEOUT):
        self.sources = sources or list(PROXY_SOURCES)
        self.refresh_min = refresh_min
        self.fetch_timeout = fetch_timeout
        self._lock = threading.Lock()
        self._pool: list[str] = []
        self._bad: set[str] = set()
        self._cursor = 0
        self._last_refresh = 0.0
        self._fetch_error: str | None = None

    # ── API publique ──────────────────────────────────────────────

    def get(self) -> str | None:
        """Retourne le prochain proxy (host:port) non bad, ou None si aucun."""
        with self._lock:
            if not self._pool or (self.refresh_min > 0 and time.time() - self._last_refresh > self.refresh_min * 60):
                self._refresh_locked()
            for _ in range(len(self._pool)):
                proxy = self._pool[self._cursor]
                self._cursor = (self._cursor + 1) % max(1, len(self._pool))
                if proxy not in self._bad:
                    return proxy
            return None

    def mark_bad(self, proxy: str) -> None:
        """Exclut un proxy mort/volatile de la rotation."""
        with self._lock:
            self._bad.add(proxy)
            log.info("[PROXY] Marquage bad : %s (total bad=%d)", proxy, len(self._bad))

    def reset(self) -> None:
        """Vide cache et blacklist (utile pour les tests)."""
        with self._lock:
            self._pool = []
            self._bad = set()
            self._cursor = 0
            self._last_refresh = 0.0
            self._fetch_error = None

    @property
    def pool_size(self) -> int:
        with self._lock:
            return len(self._pool)

    @property
    def bad_count(self) -> int:
        with self._lock:
            return len(self._bad)

    @property
    def last_fetch_error(self) -> str | None:
        with self._lock:
            return self._fetch_error

    # ── Interne ───────────────────────────────────────────────────

    def _refresh_locked(self) -> None:
        self._pool, self._fetch_error = _fetch_lists(self.sources, self.fetch_timeout)
        self._last_refresh = time.time()
        if self._pool:
            log.info("[PROXY] Liste rafraîchie : %d proxies actifs", len(self._pool))
        else:
            log.warning("[PROXY] Aucun proxy récupéré (%s)", self._fetch_error or "sources vides")


def _parse_list(text: str) -> list[str]:
    """Extrait les lignes host:port (ignore commentaires, creds, protocoles)."""
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        # "protocol://host:port" ou "user:pass@host:port" -> on garde host:port
        if "://" in line:
            line = line.split("://", 1)[1]
        if "@" in line:
            line = line.rsplit("@", 1)[1]
        host, sep, port = line.partition(":")
        if sep and _valid_port(port) and PROXY_LINE_RE.match(line):
            out.append(line)
    return out


def _fetch_lists(sources: list[str], timeout: float) -> tuple[list[str], str | None]:
    """Télécharge les listes de proxies et fusionne (sans doublons, sans bad)."""
    seen: set[str] = set()
    proxies: list[str] = []
    errors: list[str] = []
    for url in sources:
        try:
            resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0 (compatible; HamdiProno/1.0)"},
                                timeout=timeout)
            resp.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{url}: {exc}")
            log.warning("[PROXY] Échec de récupération de %s (%s)", url, exc)
            continue
        for proxy in _parse_list(resp.text):
            if proxy not in seen:
                seen.add(proxy)
                proxies.append(proxy)
    return proxies, ("; ".join(errors) if errors else None)


# ── Session par défaut partagée ──────────────────────────────────
_manager: ProxyManager | None = None
_manager_lock = threading.Lock()


def get_manager() -> ProxyManager:
    """Singleton du ProxyManager (injectable dans les tests via set_manager)."""
    global _manager
    if _manager is None:
        with _manager_lock:
            if _manager is None:
                _manager = ProxyManager()
    return _manager


def set_manager(manager: ProxyManager | None) -> None:
    """Remplace le manager global (tests)."""
    global _manager
    with _manager_lock:
        _manager = manager


def fetch_with_proxy(url: str, *, headers: dict | None = None, timeout: float = 30.0,
                     method: str = "GET", retry_status: tuple[int, ...] = PROXY_RETRY_STATUS,
                     max_attempts: int = PROXY_MAX_ATTEMPTS,
                     manager: ProxyManager | None = None) -> requests.Response:
    """Requête directe d'abord, puis rotation proxies sur échec bloquant.

    Stratégie (conforme au besoin) :
      1. Essai direct (aucun proxy) — le cas nominal, le plus rapide ;
      2. si statut ∈ retry_status OU erreur réseau (ECONNRESET/ETIMEDOUT…) :
           rotation : pour chaque proxy testé (health-check ~3 s) puis marqué
           bad en cas d'échec, on relance la requête, jusqu'à max_attempts ;
      3. si tout échoue, on relève la dernière exception.
    """
    manager = manager or get_manager()

    # 1. Essai direct
    try:
        resp = _request(method, url, headers=headers, timeout=timeout)
        if resp.status_code not in retry_status:
            return resp
        log.info("[PROXY ROTATION] HTTP %s detected on %s -> Retrying with Proxy http://x.x.x.x:yyyy (Attempt 1/%d)",
                 resp.status_code, url, max_attempts)
    except requests.RequestException as exc:
        err = _network_code(exc)
        if err not in NETWORK_ERRCODES and not isinstance(exc, (requests.ConnectionError, requests.Timeout)):
            raise
        log.info("[PROXY ROTATION] %s detected on %s -> Retrying with Proxy http://x.x.x.x:yyyy (Attempt 1/%d)",
                 err or type(exc).__name__, url, max_attempts)

    # 2. Rotation
    last_exc: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        proxy = manager.get()
        if proxy is None:
            log.warning("[PROXY ROTATION] Plus aucun proxy disponible (pool vide)")
            break
        proxies = {"http": f"http://{proxy}", "https": f"http://{proxy}"}
        # Health-check court avant l'envoi de la vraie requête
        try:
            hc = _request(method, url, headers=headers, timeout=PROXY_HEALTH_TIMEOUT, proxies=proxies)
            if hc.status_code in retry_status:
                raise _ProxyBlocked(f"proxy {proxy} renvoie HTTP {hc.status_code}")
        except _ProxyBlocked:
            manager.mark_bad(proxy)
            continue
        except requests.RequestException:
            manager.mark_bad(proxy)
            continue
        # Requête principale via le proxy testé
        try:
            resp = _request(method, url, headers=headers, timeout=timeout, proxies=proxies)
            if resp.status_code in retry_status:
                raise _ProxyBlocked(f"HTTP {resp.status_code}")
            log.info("[PROXY ROTATION] OK via %s (Attempt %d/%d)", proxy, attempt, max_attempts)
            return resp
        except _ProxyBlocked as exc:
            manager.mark_bad(proxy)
            last_exc = exc
        except requests.RequestException as exc:
            manager.mark_bad(proxy)
            last_exc = exc
        log.warning("[PROXY ROTATION] Proxy %s failed (Attempt %d/%d) - rotation", proxy, attempt, max_attempts)

    if last_exc is not None:
        raise last_exc
    raise RuntimeError(f"Tous les proxies ont échoué pour {url}")


class _ProxyBlocked(RuntimeError):
    """Proxy vivant mais réponse bloquante (403/429/503)."""


def _request(method: str, url: str, **kwargs) -> requests.Response:
    """Dispatch méthode HTTP en préservant la fonction `requests.get` (tests)."""
    return getattr(requests, method.lower())(url, **kwargs)


def _network_code(exc: Exception) -> str:
    """Extrait un code erreur réseau (ex. ECONNRESET) d'une exception requests."""
    for attr in ("errno", "strerror"):
        val = getattr(exc, attr, None)
        if val:
            return str(val)
    args = getattr(exc, "args", ())
    for arg in args:
        if isinstance(arg, BaseException):
            return _network_code(arg)
        if isinstance(arg, str):
            if arg.isupper():
                return arg
            for code in NETWORK_ERRCODES:
                if code in arg:
                    return code
    return type(exc).__name__