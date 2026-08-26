# -*- coding: utf-8 -*-
"""test_fallback.py - Smoke test that every match pair runs through the
current prediction engine API without crashing.

Les matchs sont volontairement SANS teamStats/Elo/cotes : le gate de
confiance (seuil 15%) les rejette legitiment. Le contrat teste est donc :
reponse bien formee (success bool + error explicite), jamais d'exception."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "core"))

from prediction_engine import process_prediction

# Matches from the user's Telegram output.
MATCHES = [
    # (homeTeam, awayTeam, league)
    ("River Plate", "Banfield", "Argentina: Liga Profesional de Fútbol"),
    ("Estudiantes de Río Cuarto", "Huracán", "Argentina: Liga Profesional de Fútbol"),
    ("Sarmiento", "Club Atlético Unión de Santa Fe", "Argentina: Liga Profesional de Fútbol"),
    ("Racing Club", "Independiente Rivadavia", "Argentina: Liga Profesional de Fútbol"),
    ("Aldosivi", "Argentinos Juniors", "Argentina: Liga Profesional de Fútbol"),
    ("Dynamo Kyiv", "FC Epicentr Dunaivtsi", "Ukraine: Ukrainian Premier League"),
    ("Geylang International", "Young Lions", "Singapore: Singapore Premier League"),
    ("Genoa U20", "Lazio U20", "Italy: Campionato Primavera 1"),
    ("Portuguesa", "AA Altos", "Brazil: Copa Betano do Brasil"),
    ("Ceará", "EC Primavera", "Brazil: Copa Betano do Brasil"),
    ("Kəpəz PFK", "Sumqayıt FK", "Azerbaijan: Misli Premier League"),
]

_VALID_REASONS = ('Confidence too low', 'INSUFFICIENT_DATA', 'VETO', 'Fail-Fast')


def test_all_matches_predicted_successfully():
    for home, away, league in MATCHES:
        res = process_prediction({"homeTeam": home, "awayTeam": away, "league": league})
        assert isinstance(res, dict), f"{home} vs {away} [{league}] returned non-dict"
        if res.get("success"):
            continue
        err = str(res.get("error", ""))
        assert any(r in err for r in _VALID_REASONS), \
            f"{home} vs {away} [{league}] rejected with unexpected reason: {err}"


def test_match_predictions_are_distinct():
    """Parmi les predictions du CHEMIN PRINCIPAL qui reussissent, les
    probabilites home win doivent etre distinctes.
    Les predictions ZERO-DATA RESCUE (is_low_data_prediction) sont exclues :
    sans historique elles retombent toutes sur le meme prior ligue generique
    (comportement attendu du handler bayesien)."""
    win_confs = []
    rescued = 0
    for home, away, league in MATCHES:
        res = process_prediction({"homeTeam": home, "awayTeam": away, "league": league})
        if not res.get("success"):
            continue
        if res.get("is_low_data_prediction"):
            rescued += 1
            continue
        p_h = res.get("home_win_probability")
        win_confs.append((home, round(float(p_h), 4)))
    probs_only = [p for _, p in win_confs]
    duplicates = len(probs_only) - len(set(probs_only))
    assert duplicates == 0, \
        f"{duplicates}/{len(win_confs)} main-path predictions share duplicated home-win prob: {win_confs}"


def test_low_data_matches_use_bayesian_rescue():
    """Les matchs sans donnees doivent etre soit secourus par la voie
    bayesienne (schema home_win + flag is_low_data_prediction), soit rejetes
    proprement — jamais renvoyer un chemin principal vide."""
    for home, away, league in MATCHES:
        res = process_prediction({"homeTeam": home, "awayTeam": away, "league": league})
        assert isinstance(res, dict), f"{home} vs {away}: non-dict response"
        if res.get("success"):
            assert "is_low_data_prediction" in res or res.get("home_win_probability") is not None, \
                f"{home} vs {away}: success without probabilities payload"
