import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

import json
from prediction_engine import process_prediction

# Fixtures minimales (teamStats seul, sans Elo/historique/cotes).
# Le gate de confiance du moteur (seuil dynamique 15%) rejette legitiment
# un match sans donnees : le contrat attendu est un rejet PROPRE
# ({"success": False, "error": "Confidence too low ..."}), jamais un crash.
stoke_data = json.dumps({'teamStats': {
    'home': {'avgGoalsScored': 1.44, 'avgGoalsConceded': 1.21, 'avgShotsOnTarget': 5.06, 'avgCorners': 4.8},
    'away': {'avgGoalsScored': 0.94, 'avgGoalsConceded': 1.59, 'avgShotsOnTarget': 3.76, 'avgCorners': 3.9}
}})

masry_data = json.dumps({'teamStats': {
    'home': {'avgGoalsScored': 2.1, 'avgGoalsConceded': 0.8, 'avgShotsOnTarget': 7.2, 'avgCorners': 6.1},
    'away': {'avgGoalsScored': 0.7, 'avgGoalsConceded': 1.9, 'avgShotsOnTarget': 2.9, 'avgCorners': 3.1}
}})


def _get_1x2_probs(res):
    """Probas 1X2 selon le schéma de sortie :
    - chemin principal : home_win_probability/draw_probability/away_win_probability
    - ZERO-DATA RESCUE (low_data_handler) : home_win/draw/away_win"""
    if res.get('home_win_probability') is not None:
        return (res['home_win_probability'], res['draw_probability'], res['away_win_probability'])
    return (res.get('home_win', 0), res.get('draw', 0), res.get('away_win', 0))


def assert_clean_rejection_or_valid_prediction(raw_json):
    res = process_prediction(json.loads(raw_json))
    assert isinstance(res, dict), "process_prediction must return a dict"
    if res.get('success'):
        p_h, p_d, p_a = (float(x) for x in _get_1x2_probs(res))
        assert 0.95 <= p_h + p_d + p_a <= 1.05, f"probabilities must sum to ~1, got {p_h + p_d + p_a}"
    else:
        err = str(res.get('error', ''))
        assert 'Confidence too low' in err or 'INSUFFICIENT_DATA' in err or 'VETO' in err, \
            f"unexpected rejection reason: {err}"


def test_stoke_city_prediction():
    assert_clean_rejection_or_valid_prediction(stoke_data)


def test_al_masry_prediction():
    assert_clean_rejection_or_valid_prediction(masry_data)


def test_data_poor_match_is_rejected_cleanly():
    res = process_prediction(json.loads(stoke_data))
    assert not res.get('success'), "data-poor match must be rejected by the confidence gate"
    assert 'Confidence too low' in str(res.get('error', '')), f"unexpected error: {res.get('error')}"
