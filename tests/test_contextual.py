"""
Tests for contextual.py — Contextual Adjustment Coefficient (CAC)
Contract : cac ∈ [0.85, 1.15], un factor par dimension, bloc None si flag OFF.
"""
import pytest
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))


class TestComputeCac:
    def test_no_context_returns_neutral(self):
        from contextual import compute_cac
        r = compute_cac({})
        assert r['cac'] == 1.0
        assert r['factors'] == []
        assert r['alerts'] == []
        assert r['clamped'] is False

    def test_injuries_lower_cac(self):
        from contextual import compute_cac
        r = compute_cac({'injury_impact': 4.5})
        assert r['cac'] < 1.0
        assert any(f['type'] == 'injuries' and f['delta'] < 0 for f in r['factors'])
        assert any('absences' in a for a in r['alerts'])

    def test_europe_knockout_worse_than_group(self):
        from contextual import compute_cac
        ko = compute_cac({'european_next': {'comp': 'UCL', 'stage': 'knockout', 'gap_days': 3}})
        gp = compute_cac({'european_next': {'comp': 'UEL', 'stage': 'group', 'gap_days': 3}})
        assert ko['cac'] < gp['cac']
        assert any('Rotation' in a for a in ko['alerts'])

    def test_europe_out_of_window_ignored(self):
        from contextual import compute_cac
        far = compute_cac({'european_next': {'comp': 'UCL', 'stage': 'knockout', 'gap_days': 9}})
        soon = compute_cac({'european_next': {'comp': 'UCL', 'stage': 'knockout', 'gap_days': 0.2}})
        assert far['cac'] == 1.0
        assert soon['cac'] == 1.0

    def test_rest_tiers(self):
        from contextual import compute_cac
        r48 = compute_cac({'rest_hours': 40})
        r72 = compute_cac({'rest_hours': 60})
        rok = compute_cac({'rest_hours': 100})
        assert r48['cac'] < r72['cac'] < rok['cac'] == 1.0

    def test_stake_labels(self):
        from contextual import compute_cac
        assert compute_cac({'motivation': 'TITLE'})['cac'] > 1.0
        assert compute_cac({'motivation': 'DEAD_RUBBER'})['cac'] < 1.0
        assert compute_cac({'motivation': 'STANDARD'})['cac'] == 1.0
        assert compute_cac({'motivation': 'unknown_label'})['cac'] == 1.0

    def test_clamp_bounds(self):
        from contextual import compute_cac, CAC_MIN, CAC_MAX
        brutal_neg = compute_cac({'injury_impact': 50, 'european_next': {'comp': 'UCL', 'stage': 'knockout', 'gap_days': 3}, 'rest_hours': 10, 'motivation': 'DEAD_RUBBER'})
        assert brutal_neg['cac'] == CAC_MIN
        assert brutal_neg['clamped'] is True
        brutal_pos = compute_cac({'motivation': 'TITLE'}, weights={'version': 9, 'bounds': {'min': 0.85, 'max': 1.15}, 'injury_per_point': 0.02, 'europe_next': {'knockout': 0.05, 'group': 0.03, 'min_gap_days': 0.5, 'max_gap_days': 4.5}, 'rest_hours': {'lt48': 0.06, 'lt72': 0.03}, 'stake': {'TITLE': 9.0}})
        assert brutal_pos['cac'] == CAC_MAX
        assert brutal_pos['clamped'] is True

    def test_factors_sum_before_clamp(self):
        from contextual import compute_cac
        r = compute_cac({'injury_impact': 2.0, 'motivation': 'TITLE'})
        total = 1.0 + sum(f['delta'] for f in r['factors'])
        assert abs(r['cac'] - total) < 1e-9
        assert r['clamped'] is False


class TestBuildContext:
    def test_ctx_v1_priority(self):
        from contextual import build_team_ctx
        match_obj = {
            'homeTeam': 'A', 'awayTeam': 'B',
            'news_data': {'injuries': {'home': [{'name': 'X', 'position': 'goalkeeper'}]}},
            'context': {'schema': 'ctx_v1', 'teams': {
                'home': {'injury_impact': 2.0, 'european_next': {'comp': 'UCL', 'stage': 'group', 'gap_days': 3}, 'rest_hours': 60, 'motivation': 'TITLE'},
                'away': {},
            }},
        }
        ctx = build_team_ctx(match_obj, 'home', 'A')
        assert ctx['injury_impact'] == 2.0
        assert ctx['rest_hours'] == 60
        assert ctx['motivation'] == 'TITLE'
        assert ctx['european_next']['comp'] == 'UCL'

    def test_legacy_news_data_fallback(self):
        from contextual import build_team_ctx
        match_obj = {
            'homeTeam': 'A', 'awayTeam': 'B',
            'news_data': {'homeTeam': 'A', 'injuries': {'home': [{'name': 'GK1', 'position': 'goalkeeper'}]}},
            'days_since_last_match_away': 2,
        }
        ctx = build_team_ctx(match_obj, 'home', 'A')
        assert ctx['injury_impact'] >= 4.0
        away = build_team_ctx(match_obj, 'away', 'B')
        assert away['rest_hours'] == pytest.approx(48.0)

    def test_absence_impact_scaled(self):
        from contextual import build_team_ctx
        match_obj = {'homeTeam': 'A', 'awayTeam': 'B', 'home_absence_impact': 0.5}
        assert build_team_ctx(match_obj, 'home', 'A')['injury_impact'] == pytest.approx(5.0)

    def test_days_90_placeholder_ignored(self):
        from contextual import build_team_ctx
        match_obj = {'homeTeam': 'A', 'awayTeam': 'B', 'days_since_last_match_home': 90}
        assert build_team_ctx(match_obj, 'home', 'A')['rest_hours'] is None


class TestApplyContextualCac:
    def test_disabled_by_default_computes_shadow_block(self, monkeypatch):
        from contextual import apply_contextual_cac
        monkeypatch.delenv('CONTEXTUAL_CAC_ENABLED', raising=False)
        ph, pd, pa, block = apply_contextual_cac({'homeTeam': 'A', 'awayTeam': 'B'}, 0.5, 0.3, 0.2)
        assert block is not None
        assert block['enabled'] is False and block['shadow'] is True
        assert (ph, pd, pa) == (0.5, 0.3, 0.2)
        assert block['prob_shift_pp'] == {'home': 0.0, 'draw': 0.0, 'away': 0.0}

    def test_shadow_computes_counterfactual_cac(self, monkeypatch):
        from contextual import apply_contextual_cac
        monkeypatch.delenv('CONTEXTUAL_CAC_ENABLED', raising=False)
        match_obj = {
            'homeTeam': 'A', 'awayTeam': 'B',
            'context': {'teams': {
                'home': {'injury_impact': 10.0, 'european_next': {'comp': 'UCL', 'stage': 'knockout', 'gap_days': 3}, 'rest_hours': 40},
                'away': {'motivation': 'TITLE'},
            }},
        }
        ph, pd, pa, block = apply_contextual_cac(match_obj, 0.5, 0.3, 0.2)
        assert block['enabled'] is False and block['shadow'] is True
        assert block['cac_home'] == 0.85  # brut -0.20-0.05-0.06 -> clamp, calculé quand même
        assert block['cac_away'] == 1.04
        assert (ph, pd, pa) == (0.5, 0.3, 0.2)  # probs PAS touchées en shadow

    def test_enabled_normalizes_and_shifts(self, monkeypatch):
        from contextual import apply_contextual_cac
        monkeypatch.setenv('CONTEXTUAL_CAC_ENABLED', 'on')
        match_obj = {
            'homeTeam': 'A', 'awayTeam': 'B',
            'context': {'teams': {
                'home': {'motivation': 'DEAD_RUBBER'},
                'away': {'motivation': 'TITLE'},
            }},
        }
        ph, pd, pa, block = apply_contextual_cac(match_obj, 0.5, 0.3, 0.2)
        assert abs(ph + pd + pa - 1.0) < 1e-9
        assert ph < 0.5 and pa > 0.2
        assert block['enabled'] is True and block['shadow'] is False
        assert block['cac_home'] < 1.0 < block['cac_away']
        assert abs(block['prob_shift_pp']['home'] + block['prob_shift_pp']['draw'] + block['prob_shift_pp']['away']) < 0.05
        assert [f['side'] for f in block['factors']] == ['home', 'away']
        assert set(block['alerts'].keys()) == {'home', 'away'}

    def test_neutral_cac_leaves_probs_untouched(self, monkeypatch):
        from contextual import apply_contextual_cac
        monkeypatch.setenv('CONTEXTUAL_CAC_ENABLED', 'on')
        ph, pd, pa, block = apply_contextual_cac({'homeTeam': 'A', 'awayTeam': 'B'}, 0.5, 0.3, 0.2)
        assert ph == pytest.approx(0.5) and pd == pytest.approx(0.3) and pa == pytest.approx(0.2)
        assert block['cac_home'] == 1.0 and block['cac_away'] == 1.0


class TestWeights:
    def test_load_weights_reads_config_version(self):
        from contextual import load_weights
        w = load_weights()
        assert w['bounds']['min'] == 0.85 and w['bounds']['max'] == 1.15
        assert 'DEAD_RUBBER' in w['stake']
