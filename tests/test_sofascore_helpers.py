"""
Tests pour le module sofascore_helpers (2026-09-09) — port Python de
SofascoreBypass.computeAbsenceImpact, utilisé par le pipeline de prédiction
live (/api/predict) pour injecter l'impact des absences détectées par
PixelRAG-Sofascore.

Couvre : cas vide, side explicite, match par team name, normalisation accents,
impact saturé, fallback side depuis item.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

from sofascore_helpers import compute_absence_impact, _norm_key  # noqa: E402


def test_empty_items_returns_zero():
    r = compute_absence_impact([], 'Home', 'Away')
    assert r == {'home': 0.0, 'away': 0.0}
    r = compute_absence_impact(None, 'Home', 'Away')
    assert r == {'home': 0.0, 'away': 0.0}


def test_norm_key_strips_accents_and_punct():
    assert _norm_key('Slezský FC') == 'slezskyfc'
    # "FC Zbrojovka Brno" -> retire 'F','C',' ','Z','b','r','o','j','o','v','k','a',' ','B','r','n','o'
    # -> 'fczbrojovk abrno' puis '[^a-z0-9]+' collapse -> 'fczbrojovkabrno'
    assert _norm_key('FC Zbrojovka Brno') == 'fczbrojovkabrno'
    assert _norm_key('') == ''
    assert _norm_key(None) == ''


def test_side_resolution_by_team_name():
    items = [
        {'team': 'Slezský FC Opava', 'position': 'D', 'status': 'injured', 'detail': 'knee'},
        {'team': 'FC Zbrojovka Brno', 'position': 'M', 'status': 'suspended', 'detail': 'red card'},
    ]
    r = compute_absence_impact(items, 'FC Zbrojovka Brno', 'Slezský FC Opava')
    # home (Zbrojovka) = 1 * STATUS_WEIGHT['suspended'] * POS_WEIGHT['M'] = 0.6
    # away (Opava) = 1 * STATUS_WEIGHT['injured'] * POS_WEIGHT['D'] = 0.5
    # Each divided by 3 -> 0.2, 0.167
    assert r['home'] > 0 and r['away'] > 0
    assert r['home'] > r['away'], f"home impact ({r['home']}) doit dépasser away ({r['away']})"


def test_saturation_at_one():
    # 6 absences défenseurs : 6 * 1.0 * 0.5 = 3.0 / 3 = 1.0 saturé
    items = [
        {'team': 'Home', 'position': 'D', 'status': 'injured'} for _ in range(6)
    ]
    r = compute_absence_impact(items, 'Home', 'Away')
    assert r['home'] == 1.0
    assert r['away'] == 0.0


def test_explicit_side_attribute_used():
    # Cas legacy : items portent 'side' (home/away) sans team name
    items = [
        {'side': 'home', 'position': 'F', 'status': 'injured'},
        {'side': 'home', 'position': 'F', 'status': 'doubtful'},
        {'side': 'away', 'position': 'D', 'status': 'injured'},
    ]
    r = compute_absence_impact(items, 'X', 'Y')
    # home: (1.0*0.7 + 0.4*0.7) = 0.98 / 3 ≈ 0.327
    # away: (1.0*0.5) = 0.5 / 3 ≈ 0.167
    assert 0.3 < r['home'] < 0.4, f"home attendu ~0.33, got {r['home']}"
    assert 0.15 < r['away'] < 0.2, f"away attendu ~0.17, got {r['away']}"


def test_unknown_team_ignored():
    items = [
        {'team': 'Random Club', 'position': 'D', 'status': 'injured'},
        {'team': 'Home', 'position': 'M', 'status': 'injured'},
    ]
    r = compute_absence_impact(items, 'Home', 'Away')
    # Le "Random Club" est ignoré, seul Home compte : 1*1.0*0.6 = 0.6 / 3 = 0.2
    assert r['home'] == round(min(1.0, 0.6 / 3), 3)
    assert r['away'] == 0.0


def test_unknown_status_default_weight():
    items = [
        {'team': 'Home', 'position': 'F', 'status': 'unknown'},
    ]
    r = compute_absence_impact(items, 'Home', 'Away')
    # STATUS_WEIGHT.get(unknown, 0.6) = 0.6, POS_WEIGHT['F'] = 0.7
    # -> 0.6*0.7 = 0.42 / 3 ≈ 0.14
    assert 0.13 < r['home'] < 0.15, f"home attendu ~0.14, got {r['home']}"


def test_input_safety_mixed_types():
    # L'input peut contenir des entrées malformées (None, str, dicts partiels)
    items = [
        None,
        'not a dict',
        {'team': 'Home', 'position': 'G', 'status': 'injured'},
        {'position': 'D'},  # pas de team ni side -> ignoré
    ]
    r = compute_absence_impact(items, 'Home', 'Away')
    # Seul le 3e item compte : 1*1.0*1.0 = 1.0 / 3 ≈ 0.333
    assert 0.32 < r['home'] < 0.34
    assert r['away'] == 0.0
