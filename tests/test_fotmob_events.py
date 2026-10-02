"""
Tests E71 : normalisation des evenements FotMob -> incidents pour
services/integrityScorer.js (signal ANOMALOUS_INCIDENT).

Ces tests sont 100% locaux : ils n'appellent PAS le reseau, ils verifient
uniquement la transformation de formes d'evenements FotMob (reelles) en
incidents normalises. C'est ce qui permet de brancher la timeline alors que
la base ne contenait ZERO incident.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))

from fotmobClient import _normalize_event  # noqa: E402


class TestNormalizeGoal:
    def test_goal_simple(self):
        ev = {"time": 12, "type": "Goal", "isHome": True, "player": {"name": "Smith"}}
        out = _normalize_event(ev)
        assert out["time"] == 12
        assert out["type"] == "goal"
        assert out["incidentClass"] == "regular"
        assert out["isHome"] is True
        assert "Goal" in out["text"]
        assert "Smith" in out["text"]

    def test_goal_with_time_str_only(self):
        ev = {"timeStr": "7'", "type": "Goal", "isHome": False}
        out = _normalize_event(ev)
        assert out["time"] == 7
        assert out["isHome"] is False

    def test_own_goal_detected(self):
        ev = {"time": 30, "type": "Goal", "isOwnGoal": True, "isHome": True}
        out = _normalize_event(ev)
        assert out["incidentClass"] == "own goal"
        # Le texte doit contenir "own goal" : c'est ce que integrityScorer
        # recherche via OWN_GOAL_KW.
        assert "own goal" in out["text"].lower()

    def test_penalty_via_shot_type(self):
        ev = {"time": 70, "type": "Goal", "shotType": "Penalty", "isHome": True}
        out = _normalize_event(ev)
        assert out["incidentClass"] == "penalty"

    def test_penalty_via_is_penalty_flag(self):
        ev = {"time": 80, "type": "Goal", "isPenalty": True, "isHome": False}
        out = _normalize_event(ev)
        assert out["incidentClass"] == "penalty"

    def test_own_goal_prioritaire_sur_penalty(self):
        # Un own goal marque sur penalty reste un own goal.
        ev = {"time": 40, "type": "Goal", "isOwnGoal": True, "shotType": "Penalty"}
        out = _normalize_event(ev)
        assert out["incidentClass"] == "own goal"


class TestNormalizeCard:
    def test_red_card(self):
        ev = {"time": 15, "type": "Card", "card": "red", "isHome": False}
        out = _normalize_event(ev)
        assert out["incidentClass"] == "red"
        assert out["type"] == "card"
        # integrityScorer cherche "red card" dans le texte.
        assert "red card" in out["text"].lower()

    def test_yellow_red_trait_comme_rouge(self):
        ev = {"time": 18, "type": "Card", "card": "yellowred"}
        out = _normalize_event(ev)
        assert out["incidentClass"] == "red"

    def test_yellow_card_simple(self):
        ev = {"time": 22, "type": "Card", "card": "yellow", "isHome": True}
        out = _normalize_event(ev)
        assert out["incidentClass"] == "yellow"
        assert out["time"] == 22

    def test_carte_sans_couleur(self):
        out = _normalize_event({"time": 30, "type": "Card"})
        assert out["incidentClass"] == "card"


class TestIgnores:
    def test_substitution_ignoree(self):
        assert _normalize_event({"time": 60, "type": "Substitution"}) is None

    def test_injury_ignoree(self):
        assert _normalize_event({"time": 55, "type": "InjuryTime"}) is None

    def test_type_vide_ignore(self):
        assert _normalize_event({"time": 10}) is None

    def test_non_dict_ignore(self):
        assert _normalize_event("goal") is None
        assert _normalize_event(None) is None

    def test_player_manquant_ne_leve_pas(self):
        out = _normalize_event({"time": 44, "type": "Goal", "player": None})
        assert out is not None
        assert out["time"] == 44


class TestScorerContract:
    """Garantit le contrat de forme attendu par integrityScorer.js."""

    def test_champs_obligatoires(self):
        out = _normalize_event({"time": 5, "type": "Goal", "isHome": True})
        for key in ("time", "type", "incidentClass", "isHome", "text"):
            assert key in out, f"champ manquant : {key}"

    def test_but_precoce_detectable_par_le_scorer(self):
        # Le scorer declenche EARLY_GOAL sur time <= 5.
        out = _normalize_event({"time": 3, "type": "Goal", "isHome": False})
        assert out["time"] <= 5
        assert out["type"] == "goal"

    def test_time_none_classe_en_fin_de_liste(self):
        out = _normalize_event({"type": "Goal", "isHome": True})
        assert out["time"] is None
