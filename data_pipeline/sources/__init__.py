"""Sources de données du pipeline pronos.

Le registre ``SOURCES`` est la liste ordonnée des sources homogènes
(:class:`sources.base.BaseSource`) ; ``SOURCE_BY_NAME`` permet un accès direct.
Le pipeline les consomme pour déléguer la récolte (rate limit + provenance
centralisés dans ``sources/base.py``).
"""
from __future__ import annotations

from . import clubelo, fbref, football_data
from .base import BaseSource, HttpClient, SourceResult, run_all

SOURCES = [
    football_data.FootballDataSource(),
    clubelo.ClubEloSource(),
    fbref.FbrefSource(),
]
SOURCE_BY_NAME = {s.name: s for s in SOURCES}

__all__ = [
    "SOURCES",
    "SOURCE_BY_NAME",
    "BaseSource",
    "SourceResult",
    "HttpClient",
    "run_all",
]