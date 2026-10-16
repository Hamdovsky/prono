"""
E124 : le path low-data (Zero-Data rescue, majoritaire sur ligues faibles)
n'emettait jamais ht_goal_prob (0 % en base <24h) — verrou de non-regression.
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

from low_data_handler import predict_low_data


def _coban():
    return predict_low_data({
        'homeTeam': 'Coban Imperial', 'awayTeam': 'CSD Municipal',
        'league': 'Liga Nacional: Apertura',
        '_h_hist_len': 0, '_a_hist_len': 0, 'data_completeness': 5,
    })


def test_low_data_emits_ht_goal_prob():
    out = _coban()
    assert out and out.get('success')
    ht = out.get('ht_goal_prob')
    assert ht is not None, 'le path low-data doit emettre ht_goal_prob'
    assert 0.0 < ht < 1.0


def test_low_data_keeps_core_keys():
    out = _coban()
    for k in ('home_win_probability', 'home_xg', 'away_xg', 'confidence'):
        assert out.get(k) is not None
