"""Mappage des noms d'équipes entre sources (Football-Data / ClubElo / stats avancées).

Dictionnaire de correspondance éditable dans data/team_aliases.json,
avec repli sur un matching flou (difflib) pour les noms non listés.
"""
from __future__ import annotations

import difflib
import json
import logging
from pathlib import Path

from config import ALIASES_FILE
from util import normalize_name

log = logging.getLogger(__name__)


class TeamMapper:
    """Traduit un nom d'équipe de n'importe quelle source vers un nom canonique."""

    def __init__(self, aliases_file: Path = ALIASES_FILE):
        self._alias_to_canonical: dict[str, str] = {}
        self._canonical_names: set[str] = set()
        self._norm_to_canonical: dict[str, str] = {}
        self._fuzzy_cache: dict[str, str] = {}
        if aliases_file.exists():
            data = json.loads(aliases_file.read_text(encoding="utf-8"))
            self._canonical_names = set(data.get("canonical", []))
            for canonical, aliases in data.get("aliases", {}).items():
                self._canonical_names.add(canonical)
                for alias in aliases:
                    self._alias_to_canonical[normalize_name(alias)] = canonical
        for canon in self._canonical_names:
            norm = normalize_name(canon)
            self._alias_to_canonical.setdefault(norm, canon)
            self._norm_to_canonical[norm] = canon

    def map(self, name) -> str:
        """Renvoie le nom canonique, ou le nom d'origine si introuvable."""
        return self._resolve(name)[0]

    def map_with_flag(self, name) -> tuple[str, bool]:
        """Comme :meth:`map`, avec un indicateur de correspondance."""
        return self._resolve(name)

    def _resolve(self, name) -> tuple[str, bool]:
        key = normalize_name(name)
        if not key:
            return name, False
        if key in self._alias_to_canonical:
            return self._alias_to_canonical[key], True
        if key in self._fuzzy_cache:
            return self._fuzzy_cache[key], key in self._norm_to_canonical
        matches = difflib.get_close_matches(key, list(self._norm_to_canonical), n=1, cutoff=0.9)
        if matches:
            canon = self._norm_to_canonical[matches[0]]
            self._fuzzy_cache[key] = canon
            log.debug("Mappage flou : %r -> %s", name, canon)
            return canon, True
        self._fuzzy_cache[key] = name
        log.warning("Équipe non mappée : %r", name)
        return name, False
