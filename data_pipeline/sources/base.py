"""Contrat commun des sources de données du pipeline pronos.

Toute source doit sous-classer :class:`BaseSource` et renvoyer un
:class:`SourceResult`. Le rate limiting, la traçabilité de la provenance et la
métrologie (durée, lignes, avertissements) sont gérés ici de façon homogène ;
le pipeline consomme le registre ``SOURCES`` exposé par ``sources/__init__.py``.
"""
from __future__ import annotations

import json
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests

from config import STATE_FILE
from util import RateLimiter, get_logger, retry

log = get_logger("base")

# Types de données produits par une source -> consommateurs du pipeline.
KIND_BASE = "base"          # matchs résultats + cotes + stats (Football-Data)
KIND_ELO = "elo"            # historique de rating pré-match (ClubElo)
KIND_ADVANCED = "advanced"  # stats avancées par match (xG/xA, FBref/Understat)


@dataclass
class SourceResult:
    """Résultat standardisé de toute source de données.

    - ``df``           : data renvoyée (None en cas d'échec) ;
    - ``name``         : identifiant de la source ("football_data", "clubelo", ...) ;
    - ``kind``         : type de données (base | elo | advanced) ;
    - ``provenance``   : provenance du run (ex. "fbref", "understat", "local") ;
    - ``rate_limit_s`` : intervalle appliqué (reflet de la config) ;
    - ``warnings``     : avertissements levés pendant la récolte.
    """
    name: str
    kind: str
    df: pd.DataFrame | None = None
    provenance: str = ""
    rate_limit_s: float = 0.0
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.df is not None and not self.df.empty


class HttpClient:
    """Client HTTP partagé (requests) : UA commun, timeout, retry/backoff.

    Sert de couche réseau standard pour les sources qui passent par HTTP direct
    (ex. ClubElo). Les anciennes sources qui étaient déjà testées en patchant
    leur propre ``requests`` / ``_http_get`` conservent leur chemin d'origine :
    ``HttpClient`` est le standard pour le code nouveau et les migrations.
    """

    USER_AGENT = "Mozilla/5.0 (compatible; HamdiProno/1.0)"

    @retry(n=3, delay=3.0, exceptions=(requests.RequestException,))
    def get_bytes(self, url: str, timeout: float = 30.0) -> bytes:
        resp = requests.get(url, headers={"User-Agent": self.USER_AGENT}, timeout=timeout)
        resp.raise_for_status()
        return resp.content

    def get_text(self, url: str, timeout: float = 30.0, encoding: str = "utf-8") -> str:
        return self.get_bytes(url, timeout=timeout).decode(encoding, errors="replace")


class BaseSource(ABC):
    """Interface homogène de toute source de données.

    Sous-classes :
      - renseignent ``name``, ``kind`` et ``rate_limit_s`` ;
      - implémentent :meth:`_fetch`, qui retourne ``(df, provenance, warnings)``.

    Le rate limiting est créé à partir de ``rate_limit_s`` (plus besoin de le
    passer à la main depuis le pipeline) ; provenance et durée sont tracées
    dans ``state.json`` (section ``sources``).
    """

    name: str = "source"
    kind: str = KIND_BASE
    rate_limit_s: float = 0.0

    def __init__(self, state_file: Path = STATE_FILE):
        self.state_file = state_file

    @abstractmethod
    def _fetch(self, leagues=None, seasons=None, force: bool = False) -> tuple[pd.DataFrame | None, str, list[str]]:
        """Récolte les données. Retourne ``(df, provenance, warnings)``."""

    def fetch(self, leagues=None, seasons=None, force: bool = False,
              limiter: RateLimiter | None = None) -> SourceResult:
        """Point d'entrée standard : applique le rate limit, trace la provenance."""
        limiter = limiter or RateLimiter(self.rate_limit_s)
        limiter.wait()
        started = time.monotonic()
        try:
            df, provenance, warnings = self._fetch(leagues=leagues, seasons=seasons, force=force)
        except Exception as exc:  # noqa: BLE001
            log.error("Source %s : échec global (%s)", self.name, exc)
            result = SourceResult(self.name, self.kind, None, "error", self.rate_limit_s, [str(exc)])
        else:
            result = SourceResult(
                self.name, self.kind, df,
                provenance or "ok", self.rate_limit_s, list(warnings or []),
            )
        self._track(result, time.monotonic() - started)
        return result

    def fetch_dataframe(self, leagues=None, seasons=None, force: bool = False) -> pd.DataFrame:
        """Retourne directement le DataFrame (rétro-compat pour scripts)."""
        return self.fetch(leagues=leagues, seasons=seasons, force=force).df

    def _track(self, result: SourceResult, duration_s: float) -> None:
        state = {}
        if self.state_file.exists():
            state = json.loads(self.state_file.read_text(encoding="utf-8"))
        sources = state.setdefault("sources", {})
        sources[self.name] = {
            "kind": result.kind,
            "provenance": result.provenance,
            "last_run": datetime.now(timezone.utc).isoformat(),
            "duration_s": round(duration_s, 2),
            "rows": 0 if not result.ok else int(len(result.df)),
            "warnings": result.warnings,
        }
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self.state_file.write_text(json.dumps(state, indent=2), encoding="utf-8")


def run_all(sources, leagues=None, seasons=None, force: bool = False) -> dict[str, SourceResult]:
    """Itère sur un registre de sources et renvoie ``{name: SourceResult}``.

    À utiliser pour les sources sans dépendance d'ordre ; si une source dépend
    des données d'une autre (ex. Elo -> Football-Data), orchestrer manuellement
    dans le pipeline en injectant l'entrée avant l'appel :meth:`~BaseSource.fetch`.
    """
    results: dict[str, SourceResult] = {}
    for source in sources:
        results[source.name] = source.fetch(leagues=leagues, seasons=seasons, force=force)
    return results