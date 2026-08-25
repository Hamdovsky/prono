"""
Tests for ml_ensemble.py — XGBoost Model Chain, Ensemble Blending & SHAP
"""
import pytest
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))


class TestSelectModelBooster:
    def test_returns_tuple_of_4(self):
        from ml_ensemble import select_model_booster
        result = select_model_booster({}, 'T2')
        assert len(result) == 4
        names, vector, source, booster = result
        assert isinstance(names, list)
        assert isinstance(vector, list)
        assert isinstance(source, str)

    def test_feature_vector_matches_names(self):
        from ml_ensemble import select_model_booster
        names, vector, _, _ = select_model_booster({'fifa_rank_h': 10, 'fifa_rank_a': 20}, 'T1')
        assert len(vector) == len(names)

    def test_ai_source_not_empty(self):
        from ml_ensemble import select_model_booster
        _, _, source, _ = select_model_booster({}, 'T2')
        assert len(source) > 0

    def test_wc2026_match_with_ranks(self):
        from ml_ensemble import select_model_booster
        names, vector, source, booster = select_model_booster(
            {'fifa_rank_h': 15, 'fifa_rank_a': 25}, 'T1'
        )
        assert len(vector) == len(names)


class TestBlendFinalProbabilities:
    def test_xgb_dominant_blend(self):
        from ml_ensemble import blend_final_probabilities
        p_h, p_d, p_a, weight, label = blend_final_probabilities(
            0.6, 0.2, 0.2, 0.4, 0.3, 0.3, True
        )
        assert weight == 0.95
        assert 'XGB' in label or 'Titanium' in label
        assert abs(p_h + p_d + p_a - 1.0) < 0.001

    def test_poisson_fallback(self):
        from ml_ensemble import blend_final_probabilities
        p_h, p_d, p_a, weight, label = blend_final_probabilities(
            0.6, 0.2, 0.2, 0.4, 0.3, 0.3, False
        )
        assert weight == 0.0
        assert 'Poisson' in label
        assert abs(p_h + p_d + p_a - 1.0) < 0.001

    def test_normalized_output(self):
        from ml_ensemble import blend_final_probabilities
        p_h, p_d, p_a, _, _ = blend_final_probabilities(
            0.7, 0.15, 0.15, 0.5, 0.25, 0.25, True
        )
        assert abs(p_h + p_d + p_a - 1.0) < 0.001

    def test_zero_sum_fallback(self):
        from ml_ensemble import blend_final_probabilities
        p_h, p_d, p_a, _, _ = blend_final_probabilities(
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, False
        )
        assert p_h == 0.33
        assert p_d == 0.33
        assert p_a == 0.34


class TestPredictSecondaryMarkets:
    def test_default_values(self):
        from ml_ensemble import predict_secondary_markets
        corners, cards = predict_secondary_markets({}, [])
        assert corners > 0
        assert cards > 0

    def test_custom_values(self):
        from ml_ensemble import predict_secondary_markets
        features = {'home_corners': 6.0, 'away_corners': 5.0, 'home_cards': 2.5, 'away_cards': 1.5}
        corners, cards = predict_secondary_markets(features, [])
        assert isinstance(corners, float)
        assert isinstance(cards, float)
        assert corners > 0
        assert cards > 0


class TestRunXGBoostInference:
    def test_no_booster_returns_poisson(self):
        from ml_ensemble import run_xgboost_inference
        sim = {'p_h': 0.4, 'p_d': 0.3, 'p_a': 0.3}
        result = run_xgboost_inference([], [], None, sim, {}, {}, 'test', 'T2')
        assert result['has_xgb'] is False
        assert 'Poisson' in result['ai_source']

    def test_returns_required_keys(self):
        from ml_ensemble import run_xgboost_inference
        sim = {'p_h': 0.4, 'p_d': 0.3, 'p_a': 0.3}
        result = run_xgboost_inference([], [], None, sim, {}, {}, 'test', 'T2')
        required = ['p_h_xgb', 'p_d_xgb', 'p_a_xgb', 'p_h_ai', 'p_d_ai', 'p_a_ai', 'has_xgb', 'ai_source', 'explainer_data', 'analysis']
        for key in required:
            assert key in result


class TestApplyExternalXGBBlend:
    def test_no_external_no_change(self):
        from ml_ensemble import apply_external_xgb_blend
        h, d, a, tag, analysis = apply_external_xgb_blend(0.5, 0.3, 0.2, {'league': 'Ligue 2'})
        assert tag == ""
        assert abs(h - 0.5) < 0.001

    def test_missing_teams_no_change(self):
        from ml_ensemble import apply_external_xgb_blend
        h, d, a, tag, _ = apply_external_xgb_blend(0.5, 0.3, 0.2, {'league': 'Premier League'})
        assert tag == ""

    def test_sums_to_one_after_blend(self):
        from ml_ensemble import apply_external_xgb_blend
        match_obj = {'league': 'Premier League', 'homeTeam': 'Man United', 'awayTeam': 'Arsenal'}
        h, d, a, tag, analysis = apply_external_xgb_blend(0.5, 0.3, 0.2, match_obj)
        assert tag == "+ExternalXGB"
        assert abs(h + d + a - 1.0) < 0.001
        assert all(0.0 <= p <= 1.0 for p in (h, d, a))

    def test_extended_match_obj_tracks_member(self):
        from ml_ensemble import apply_external_xgb_blend
        match_obj = {'league': 'Premier League', 'homeTeam': 'Man United', 'awayTeam': 'Arsenal'}
        apply_external_xgb_blend(0.5, 0.3, 0.2, match_obj)
        assert isinstance(match_obj.get('_external_xgb'), dict)
        assert 'home' in match_obj['_external_xgb']
        assert '_external_xgb_weight' in match_obj

    def test_weight_capped(self):
        from ml_ensemble import _get_external_xgb_weight
        assert _get_external_xgb_weight('Premier League') == 0.20
        assert 0.0 <= _get_external_xgb_weight('Unknown League') <= 0.50


class TestConfluenceWithExternal:
    def test_external_confirmation_boosts(self):
        from confidence_engine import evaluate_confluence
        match_obj = {'_external_xgb': {'home': 0.50, 'draw': 0.28, 'away': 0.22}, 'odds_home': 1.95, 'odds_draw': 3.4, 'odds_away': 4.1}
        penalty, report, reason = evaluate_confluence(0.52, 0.26, 0.22, 0.50, 0.27, 0.23, 0.0, 0.0, 'T1', True, match_obj)
        assert report.get('level') == 'STRONG'
        assert penalty <= 0.0

    def test_external_absent_no_error(self):
        from confidence_engine import evaluate_confluence
        match_obj = {'odds_home': 1.95}
        penalty, report, reason = evaluate_confluence(0.52, 0.26, 0.22, 0.50, 0.27, 0.23, 0.0, 0.0, 'T1', True, match_obj)
        assert report.get('external_divergence') is None
