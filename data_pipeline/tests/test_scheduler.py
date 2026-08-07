"""Tests du lanceur planifié : déclenchement des stats avancées (tous les 3 jours)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

import run_scheduled as rs


def _state(last: str | None) -> dict:
    return {"fbref_last_run": last} if last else {}


def test_fbref_due_sans_historique() -> None:
    assert rs._fbref_due({}) is True
    assert rs._fbref_due(_state(None)) is True


def test_fbref_due_pas_encore_3_jours() -> None:
    last = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    assert rs._fbref_due(_state(last)) is False


def test_fbref_due_a_3_jours_exacts() -> None:
    last = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    assert rs._fbref_due(_state(last)) is True


def test_fbref_due_ancien() -> None:
    last = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    assert rs._fbref_due(_state(last)) is True


def test_fbref_due_date_invalide() -> None:
    assert rs._fbref_due(_state("pas-une-date")) is True
