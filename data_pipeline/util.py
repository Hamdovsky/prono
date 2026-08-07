"""Utilitaires partagés : logs, rate limiting, retries, normalisation de noms."""
from __future__ import annotations

import logging
import math
import re
import sys
import threading
import time
import unicodedata


def setup_logging(level: int = logging.INFO) -> None:
    """Configure la sortie des logs sur stdout."""
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        stream=sys.stdout,
        force=True,
    )


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


class RateLimiter:
    """Attend l'intervalle minimum entre deux requêtes consécutives."""

    def __init__(self, min_interval: float = 3.5):
        self.min_interval = min_interval
        self._lock = threading.Lock()
        self._last = 0.0

    def wait(self) -> None:
        if self.min_interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            wait = self.min_interval - (now - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()


def retry(n: int = 3, delay: float = 5.0, exceptions: tuple = (Exception,)):
    """Relance une fonction sur erreur (avec backoff linéaire)."""

    def deco(fn):
        def wrapper(*args, **kwargs):
            last = None
            for attempt in range(n):
                try:
                    return fn(*args, **kwargs)
                except exceptions as exc:  # noqa: BLE001
                    last = exc
                    if attempt == n - 1:
                        break
                    get_logger("util").warning(
                        "Échec de %s (%s), nouvel essai %d/%d dans %.0fs",
                        getattr(fn, "__name__", str(fn)), exc, attempt + 1, n, delay,
                    )
                    time.sleep(delay * (attempt + 1))
            raise last

        return wrapper

    return deco


def strip_accents(text: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c)
    )


def normalize_name(name) -> str:
    """Normalise un nom d'équipe : minuscules, sans accents ni ponctuation."""
    if name is None or (isinstance(name, float) and math.isnan(name)):
        return ""
    s = strip_accents(str(name)).lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()
