"""Tests des utilitaires : RateLimiter, retry, normalisation de noms."""
from __future__ import annotations

import time

import pytest

from util import RateLimiter, normalize_name, retry


def test_rate_limiter_respecte_l_intervalle() -> None:
    limiter = RateLimiter(0.2)
    t0 = time.monotonic()
    limiter.wait()
    limiter.wait()
    elapsed = time.monotonic() - t0
    # Windows : granularité du timer ~15,6 ms → marge de 20 ms (comme le test thread-safe)
    assert elapsed >= 0.2 - 0.02


def test_rate_limiter_intervalle_nul_passe_directement() -> None:
    limiter = RateLimiter(0.0)
    t0 = time.monotonic()
    limiter.wait()
    assert time.monotonic() - t0 < 0.05


def test_rate_limiter_est_thread_safe() -> None:
    import threading

    limiter = RateLimiter(0.1)
    limiter.wait()  # warm-up : la première attente est libre (pas d'historique)
    t_start = time.monotonic()

    def worker() -> None:
        for _ in range(5):
            limiter.wait()

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    elapsed = time.monotonic() - t_start
    # Les 20 appels sont sérialisés par le verrou : chaque mise à jour du
    # timestamp _last est espacée d'au moins 0.1 s de la précédente, même si
    # un thread arrive "en retard" (son attente est alors libre, mais l'horloge
    # murale a de toute façon avancé d'au moins l'intervalle). Le temps mural
    # total est donc >= 20 x 0.1 s quel que soit l'ordonnancement des threads.
    assert elapsed >= 20 * 0.1 - 0.05


def test_retry_relance_puis_succeed() -> None:
    calls = {"n": 0}

    @retry(n=3, delay=0.0)
    def flaky() -> str:
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("boom")
        return "ok"

    assert flaky() == "ok"
    assert calls["n"] == 3


def test_retry_abandonne_apres_n_tentatives() -> None:
    calls = {"n": 0}

    @retry(n=3, delay=0.0)
    def always_fails() -> None:
        calls["n"] += 1
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        always_fails()
    assert calls["n"] == 3


def test_normalize_name_sans_accents_ni_ponctuation() -> None:
    assert normalize_name("Atlético Madrid!") == "atletico madrid"
    assert normalize_name("Man Utd.") == "man utd"
    assert normalize_name(None) == ""
    assert normalize_name(float("nan")) == ""
    assert normalize_name("  Multiple   Spaces  ") == "multiple spaces"
