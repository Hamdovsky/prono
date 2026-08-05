# -*- coding: utf-8 -*-
"""test_fallback.py - Smoke test that every match pair produces DISTINCT
prediction percentages through the current prediction engine API."""
import json
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


def test_all_matches_predicted_successfully():
    for home, away, league in MATCHES:
        res = process_prediction({"homeTeam": home, "awayTeam": away, "league": league})
        assert res.get("success"), f"{home} vs {away} [{league}] failed: {res.get('error')}"


def test_match_predictions_are_distinct():
    win_confs = []
    for home, away, league in MATCHES:
        res = process_prediction({"homeTeam": home, "awayTeam": away, "league": league})
        win_confs.append(round(float(res.get("home_win_probability", 0)), 4))
    unique = len(set(win_confs))
    assert unique > 1, f"All {len(win_confs)} matches share the same win confidence: {win_confs}"
