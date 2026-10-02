"""
Tests E71 : core/suspicious_match_guard.py

Priorite de ces tests : prouver que le garde BLOQUE les situations documentees
ET surtout qu'il ne bloque PAS un match normal. Un veto dur sur un match sain
detruit un vrai value bet, c'est le principal risque de ce module.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

from suspicious_match_guard import (  # noqa: E402
    assess_suspicious_match, H2H_MIN_GAMES, H2H_MIN_DRAW_RATE,
    CRITICAL_SIGNALS, NON_CRITICAL_THRESHOLD,
)


def h2h_match(draws=2, total=8, home='A', away='B'):
    """Construit un match avec un historique H2H artificiel."""
    meetings = []
    for i in range(total):
        if i < draws:
            hs, as_ = 1, 1
        else:
            hs, as_ = 2, 1
        meetings.append({
            'homeTeam': home, 'awayTeam': away,
            'homeScore': hs, 'awayScore': as_,
            'startTimestamp': 1600000000 + i * 86400,
        })
    return {'teamStats': {'h2h': {'lastMeetings': meetings}}}


class TestPasDeFauxPositif:
    """Le match ordinaire ne doit JAMAIS etre bloque."""

    def test_match_normal_passe(self):
        r = assess_suspicious_match({}, h_is_dz=False, a_is_dz=False, h_dmf=1.0, a_dmf=1.0)
        assert r['is_suspicious'] is False
        assert r['signals'] == []
        assert r['reason'] == ''

    def test_match_h2h_normal_passe(self):
        # 2 nuls sur 8 = 25% : loin du seuil
        r = assess_suspicious_match(h2h_match(draws=2, total=8))
        assert r['is_suspicious'] is False

    def test_h2h_trop_court_ignore(self):
        # 100% de nuls mais sur 3 matchs : pas assez pour conclure
        r = assess_suspicious_match(h2h_match(draws=3, total=3))
        assert r['signals'] == []
        assert r['is_suspicious'] is False

    def test_une_seule_equipe_en_zone_morte_passe(self):
        # Une équipe morte + une équipe neutre : pas d'asymétrie (DMF < 1.15)
        r = assess_suspicious_match({}, h_is_dz=True, a_is_dz=False, h_dmf=1.0, a_dmf=1.0)
        assert r['signals'] == []
        assert r['is_suspicious'] is False

    def test_payload_vide_passe(self):
        assert assess_suspicious_match({})['is_suspicious'] is False
        assert assess_suspicious_match(None)['is_suspicious'] is False

    def test_h2h_malforme_ne_leve_pas(self):
        r = assess_suspicious_match({'teamStats': 'pas du json'})
        assert r['is_suspicious'] is False
        r2 = assess_suspicious_match({'teamStats': {'h2h': None}})
        assert r2['is_suspicious'] is False

    def test_h2h_scores_imbriques(self):
        # forme {current: n} au lieu d'un scalaire
        m = h2h_match(draws=6, total=8)
        for mt in m['teamStats']['h2h']['lastMeetings']:
            hs, as_ = mt['homeScore'], mt['awayScore']
            mt['homeScore'] = {'current': hs}
            mt['awayScore'] = {'current': as_}
        r = assess_suspicious_match(m)
        assert 'H2H_DRAW_PACT' in r['signals']


class TestDeadZone:
    def test_zone_morte_bilaterale_bloque(self):
        r = assess_suspicious_match({}, h_is_dz=True, a_is_dz=True)
        assert r['is_suspicious'] is True
        assert 'DEAD_ZONE_BOTH' in r['signals']
        assert 'DEAD_ZONE_BOTH' in r['critical']

    def test_zone_morte_valeurs_non_bool(self):
        # h_is_dz peut arriver en 1/0 depuis une source numerique
        r = assess_suspicious_match({}, h_is_dz=1, a_is_dz=1)
        assert r['is_suspicious'] is True

    def test_zone_morte_strings(self):
        r = assess_suspicious_match({}, h_is_dz='true', a_is_dz='true')
        assert r['is_suspicious'] is True


class TestAsymetrieMotivation:
    def test_equipe_morte_contre_equipe_motivee_bloque(self):
        r = assess_suspicious_match({}, h_is_dz=True, a_is_dz=False, h_dmf=1.0, a_dmf=1.5)
        assert 'MOTIVATION_ASYMMETRY' in r['signals']
        # non critique + seuil = 2 => pas encore bloquant
        assert r['is_suspicious'] is False

    def test_deux_signaux_non_critiques_bloquent(self):
        r = assess_suspicious_match(
            h2h_match(draws=1, total=8), h_is_dz=True, a_is_dz=False, h_dmf=1.0, a_dmf=1.5
        )
        assert r['is_suspicious'] is False
        # avec le registre, le 2e signal non critique declenche
        r2 = assess_suspicious_match(
            h2h_match(draws=1, total=8), h_is_dz=True, a_is_dz=False, h_dmf=1.0, a_dmf=1.5,
            registry={'home': {'recidivist': True}},
        )
        assert r2['signals'] == ['MOTIVATION_ASYMMETRY', 'RECIDIVIST_TEAM']
        assert r2['is_suspicious'] is True

    def test_dmf_au_seuil_exact(self):
        r = assess_suspicious_match({}, h_is_dz=True, a_is_dz=False, h_dmf=1.0, a_dmf=1.15)
        assert 'MOTIVATION_ASYMMETRY' in r['signals']


class TestH2HPact:
    def test_pacte_de_nuls_bloque(self):
        # 5 nuls sur 8 = 62.5% >= 60%
        r = assess_suspicious_match(h2h_match(draws=5, total=8))
        assert r['is_suspicious'] is True
        assert 'H2H_DRAW_PACT' in r['critical']

    def test_au_seuil_exact(self):
        # Le plus petit nombre de nuls qui atteint exactement le seuil :
        # ceil(6 * 0.60) = 4 nuls -> 4/6 = 66.7% >= 60%.
        import math
        draws = math.ceil(H2H_MIN_GAMES * H2H_MIN_DRAW_RATE)
        r = assess_suspicious_match(h2h_match(draws=draws, total=H2H_MIN_GAMES))
        assert 'H2H_DRAW_PACT' in r['signals']

    def test_une_de_moins_passe(self):
        # Un nul de moins -> sous le seuil => aucun signal
        import math
        draws = math.ceil(H2H_MIN_GAMES * H2H_MIN_DRAW_RATE) - 1
        r = assess_suspicious_match(h2h_match(draws=draws, total=H2H_MIN_GAMES))
        assert 'H2H_DRAW_PACT' not in r['signals']

    def test_juste_au_dessous_du_seuil_passe(self):
        total = 10
        draws = int(total * H2H_MIN_DRAW_RATE) - 1
        r = assess_suspicious_match(h2h_match(draws=draws, total=total))
        assert 'H2H_DRAW_PACT' not in r['signals']

    def test_compte_details_exposes(self):
        r = assess_suspicious_match(h2h_match(draws=5, total=8))
        assert r['details']['H2H_DRAW_PACT'].startswith('5/8')


class TestRecidiviste:
    def test_registre_une_seule_equipe_bloque(self):
        # RECIDIVIST est un motif unique dans la plupart des cas, donc on vérifie
        # qu'il combine avec un autre pour bloquer.
        r = assess_suspicious_match({}, registry={'away': {'recidivist': True}})
        assert r['signals'] == ['RECIDIVIST_TEAM']
        assert r['is_suspicious'] is False

    def test_registre_via_match_obj(self):
        m = {'integrity_registry': {'home': {'recidivist': True}}}
        r = assess_suspicious_match(m)
        assert 'RECIDIVIST_TEAM' in r['signals']

    def test_registre_non_recidiviste(self):
        r = assess_suspicious_match({}, registry={'home': {'recidivist': False}})
        assert r['signals'] == []


class TestRobustesse:
    def test_ne_leve_jamais(self):
        cas = [
            None, {}, [], 'texte', 42,
            {'teamStats': 12345},
            {'teamStats': {'h2h': {'lastMeetings': 'pas une liste'}}},
            {'teamStats': {'h2h': {'lastMeetings': [{'homeScore': None, 'awayScore': None}]}}},
            {'integrity_registry': 'nope'},
            {'integrity_registry': {'home': 'nope'}},
        ]
        for m in cas:
            r = assess_suspicious_match(m, h_is_dz=False, a_is_dz=False)
            assert isinstance(r, dict)
            assert 'is_suspicious' in r
            assert r['is_suspicious'] in (True, False)

    def test_types_numeriques_bizarres(self):
        r = assess_suspicious_match({}, h_is_dz=True, a_is_dz=False,
                                    h_dmf='abc', a_dmf=None)
        assert r['is_suspicious'] is False

    def test_raison_lisible(self):
        r = assess_suspicious_match({}, h_is_dz=True, a_is_dz=True)
        assert 'DEAD_ZONE_BOTH' in r['reason']
        assert 'Match suspect' in r['reason']


class TestContrat:
    def test_toujours_les_5_cles(self):
        r = assess_suspicious_match({})
        for k in ('is_suspicious', 'signals', 'critical', 'reason', 'details'):
            assert k in r

    def test_signaux_sont_connus(self):
        connus = CRITICAL_SIGNALS | {'MOTIVATION_ASYMMETRY', 'RECIDIVIST_TEAM'}
        for args in [
            {'h_is_dz': True, 'a_is_dz': True},
            {'h_is_dz': True, 'a_is_dz': False, 'a_dmf': 1.9},
        ]:
            r = assess_suspicious_match({}, **args)
            for s in r['signals']:
                assert s in connus

    def test_seuil_non_critique(self):
        assert NON_CRITICAL_THRESHOLD == 2


class TestRegistreIntegrite:
    """Regression E71 : le signal RECIDIVIST_TEAM ne pouvait pas se declencher.

    enriched_predictions.js injecte la LIGNE BRUTE produite par un
    `SELECT * FROM integrity_registry` (colonnes team/flagged_count/avg_score/
    max_score/last_flagged/league). La table n'a PAS de colonne `recidivist`,
    alors que le garde ne lisait que ce champ : le signal restait muet en
    production, et le registre Popule ne servait a rien. Le garde doit donc
    deduire la recidive du `flagged_count` quand le champ n'est pas present.
    """

    @staticmethod
    def _ligne_brute(flagged_count=4):
        return {
            'team': 'Arterivo Wakayama', 'flagged_count': flagged_count,
            'avg_score': 50, 'max_score': 50, 'last_flagged': 'A_SURVEILLER',
            'league': 'Japanese Emperor\'s Cup',
        }

    def test_forme_brute_detecte_le_recidiviste(self):
        r = assess_suspicious_match(
            {'integrity_registry': {'home': self._ligne_brute(4), 'away': None}},
            h_is_dz=False, a_is_dz=False, h_dmf=1.0, a_dmf=1.0,
        )
        assert 'RECIDIVIST_TEAM' in r['signals']
        # 1 seul signal non critique => pas encore de veto
        assert r['is_suspicious'] is False

    def test_forme_canonique_reste_supportee(self):
        row = dict(self._ligne_brute(4), recidivist=True)
        r = assess_suspicious_match(
            {'integrity_registry': {'home': row, 'away': None}},
            h_is_dz=True, a_is_dz=False, h_dmf=0.5, a_dmf=1.6,
        )
        assert 'RECIDIVIST_TEAM' in r['signals']
        assert r['is_suspicious'] is True

    def test_forme_brute_plus_motivation_declenche_le_veto(self):
        r = assess_suspicious_match(
            {'integrity_registry': {'home': self._ligne_brute(4), 'away': None}},
            h_is_dz=True, a_is_dz=False, h_dmf=0.5, a_dmf=1.6,
        )
        assert set(r['signals']) == {'MOTIVATION_ASYMMETRY', 'RECIDIVIST_TEAM'}
        assert r['is_suspicious'] is True

    def test_une_seule_occurrence_nest_pas_recidiviste(self):
        # Le registre ne contient par construction que des >= 2, mais on
        # verifie le seuil pour eviter un veto sur une ligne isolee.
        r = assess_suspicious_match(
            {'integrity_registry': {'home': self._ligne_brute(1), 'away': None}},
            h_is_dz=True, a_is_dz=False, h_dmf=0.5, a_dmf=1.6,
        )
        assert 'RECIDIVIST_TEAM' not in r['signals']
        assert r['is_suspicious'] is False

    def test_registre_absent_ne_bloque_rien(self):
        r = assess_suspicious_match({'homeTeam': 'A', 'awayTeam': 'B'})
        assert r['signals'] == []
        assert r['is_suspicious'] is False
