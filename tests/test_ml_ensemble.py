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


class TestApplyPredixSportBlend:
    def test_no_predixsport_no_change(self):
        from ml_ensemble import apply_predixsport_blend
        h, d, a, tag, analysis = apply_predixsport_blend(0.5, 0.3, 0.2, {})
        assert tag == ""
        assert abs(h - 0.5) < 0.001

    def test_valid_predixsport_blends(self):
        from ml_ensemble import apply_predixsport_blend
        match_obj = {'predixsport': {'home_win': 0.6, 'draw': 0.2, 'away_win': 0.2}}
        h, d, a, tag, analysis = apply_predixsport_blend(0.5, 0.3, 0.2, match_obj)
        assert tag == "+PredixSport"
        assert abs(h + d + a - 1.0) < 0.001

    def test_zero_sum_predixsport_ignored(self):
        from ml_ensemble import apply_predixsport_blend
        match_obj = {'predixsport': {'home_win': 0, 'draw': 0, 'away_win': 0}}
        h, d, a, tag, _ = apply_predixsport_blend(0.5, 0.3, 0.2, match_obj)
        assert tag == ""


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
        assert abs(corners - 11.0) < 0.1
        assert abs(cards - 4.0) < 0.1


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
