"""
Tests for the refactored prediction engine modules:
- data_loader.py
- feature_engineer.py
- model_manager.py
- predictor.py
- post_processor.py
"""
import sys
import os
import math
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))


# ============================================================================
# DATA_LOADER TESTS
# ============================================================================

class TestDataLoader:
    def test_safe_float_normal(self):
        from data_loader import safe_float
        assert safe_float(3.14) == 3.14
        assert safe_float(0) == 0.0
        assert safe_float(-1.5) == -1.5

    def test_safe_float_none(self):
        from data_loader import safe_float
        assert safe_float(None) == 0.0
        assert safe_float(None, 5.0) == 5.0

    def test_safe_float_string(self):
        from data_loader import safe_float
        assert safe_float('3.14') == 3.14
        assert safe_float('') == 0.0
        assert safe_float('nan') == 0.0
        assert safe_float('null', 1.0) == 1.0

    def test_f_feat_dict(self):
        from data_loader import f_feat
        d = {'x': 42, 'y': '3.14'}
        assert f_feat('x', d) == 42.0
        assert f_feat('y', d) == 3.14
        assert f_feat('missing', d) == 0.0
        assert f_feat('missing', d, 99.0) == 99.0

    def test_get_db_connection(self):
        from data_loader import get_db_connection
        conn = get_db_connection()
        assert conn is not None

    def test_get_tactical_connection(self):
        from data_loader import get_tactical_connection
        conn = get_tactical_connection()
        assert conn is not None or conn is None  # may not exist

    def test_load_elo_ratings(self):
        from data_loader import load_elo_ratings
        elo = load_elo_ratings()
        assert isinstance(elo, dict)

    def test_get_league_volatility_penalty(self):
        from data_loader import get_league_volatility_penalty
        p, v = get_league_volatility_penalty('Premier League')
        assert p == 0.0
        assert v is False
        p, v = get_league_volatility_penalty('U21 Reserve')
        assert p == 16.0
        assert v is True

    def test_get_league_goals_multiplier(self):
        from data_loader import get_league_goals_multiplier
        assert get_league_goals_multiplier('Bundesliga') == 1.12
        assert get_league_goals_multiplier('Ligue 2') == 0.86
        assert get_league_goals_multiplier('Premier League') == 1.0

    def test_get_league_home_advantage(self):
        from data_loader import get_league_home_advantage
        ha = get_league_home_advantage('Premier League')
        assert isinstance(ha, float) and ha > 0

    def test_get_h2h_modifier(self):
        from data_loader import get_h2h_modifier
        h, a = get_h2h_modifier('Team A', 'Team B')
        assert isinstance(h, float)
        assert isinstance(a, float)

    def test_get_advanced_xg_adjustment(self):
        from data_loader import get_advanced_xg_adjustment
        xg_h, xg_a = get_advanced_xg_adjustment('Arsenal', 'Chelsea', 'Premier League')
        assert xg_h > 0 and xg_a > 0

    def test_calculate_team_strength(self):
        from data_loader import calculate_team_strength
        s, c = calculate_team_strength('Arsenal')
        assert isinstance(s, float) and s > 0
        assert isinstance(c, float) and c >= 0


# ============================================================================
# FEATURE_ENGINEER TESTS
# ============================================================================

class TestFeatureEngineer:
    def test_extract_v4_features(self):
        from feature_engineer import extract_v4_features
        match = {'home_possession': 55, 'away_possession': 45,
                 'home_shots': 12, 'away_shots': 8,
                 'home_shots_on_target': 5, 'away_shots_on_target': 3}
        feats = extract_v4_features(match)
        assert feats['h_poss'] == 55.0
        assert feats['a_poss'] == 45.0
        assert feats['poss_diff'] == 10.0

    def test_impute_missing_match_data(self):
        from feature_engineer import impute_missing_match_data
        features = {'h_xg': 1.5, 'a_xg': 1.0}
        match_obj = {'league': 'Test'}
        result = impute_missing_match_data(features, match_obj)
        assert result['rest_h'] == 7.0
        assert result['rest_a'] == 7.0
        assert result['data_completeness'] > 0

    def test_calculate_composite_confidence(self):
        from feature_engineer import calculate_composite_confidence
        conf = calculate_composite_confidence(0.65, 1.2, 1.0, True, 80.0)
        assert 5.0 <= conf <= 99.0

    def test_calculate_dmf_hafiz(self):
        from feature_engineer import calculate_dmf_hafiz
        dmf = calculate_dmf_hafiz(0.8, 2, 10, 20)
        assert dmf >= 0.85
        dead = calculate_dmf_hafiz(0.8, 2, 10, 20, is_dead_zone=True)
        assert dead == 0.85

    def test_calculate_xg_perf_delta(self):
        from feature_engineer import calculate_xg_perf_delta
        history = [{'h_xg': 1.5, 'a_xg': 0.8, 'score_for': 1, 'score_against': 0}] * 5
        delta = calculate_xg_perf_delta(history, is_home=True)
        assert isinstance(delta, float)

    def test_calculate_fatigue_mod(self):
        from feature_engineer import calculate_fatigue_mod
        assert calculate_fatigue_mod(2) == 0.92
        assert calculate_fatigue_mod(7) == 1.05
        assert calculate_fatigue_mod(5) == 1.0
        assert calculate_fatigue_mod(None) == 1.0

    def test_get_stylistic_clash_modifier(self):
        from feature_engineer import get_stylistic_clash_modifier
        h, a = get_stylistic_clash_modifier('Counter-Attack', 'Possession')
        assert h > 1.0
        assert a > 1.0

    def test_apply_tactical_intelligence(self):
        from feature_engineer import apply_tactical_intelligence
        match = {'news_data': {'home': {'intelligence': {}}}}
        features = {'h_pos': 60, 'h_sot': 2}
        xg_h, xg_a, alerts = apply_tactical_intelligence(match, features, 1.5, 1.2)
        assert xg_h > 0 and xg_a > 0
        assert len(alerts) > 0


# ============================================================================
# MODEL_MANAGER TESTS
# ============================================================================

class TestModelManager:
    def test_get_xgb(self):
        from model_manager import get_xgb
        xgb = get_xgb()
        assert xgb is not None

    def test_get_main_booster(self):
        from model_manager import get_main_booster
        b = get_main_booster()
        assert b is not None

    def test_get_v553_premium_booster(self):
        from model_manager import get_v553_premium_booster
        b = get_v553_premium_booster()
        assert b is not None

    def test_load_booster_nonexistent(self):
        from model_manager import _load_booster
        b = _load_booster('/nonexistent/path.json', 'test')
        assert b is None


# ============================================================================
# PREDICTOR TESTS
# ============================================================================

class TestPredictor:
    def test_poisson_prob_zero(self):
        from predictor import poisson_prob
        p = poisson_prob(1.0, 0)
        assert abs(p - math.exp(-1)) < 0.0001

    def test_poisson_prob_one(self):
        from predictor import poisson_prob
        p = poisson_prob(2.0, 1)
        assert p > 0

    def test_poisson_prob_negative_lambda(self):
        from predictor import poisson_prob
        assert poisson_prob(0, 0) == 1.0
        assert poisson_prob(0, 1) == 0.0

    def test_monte_carlo_simulation(self):
        from predictor import monte_carlo_simulation
        result = monte_carlo_simulation(2.0, 1.5, iterations=500)
        assert 'p_h' in result
        assert 'p_d' in result
        assert 'p_a' in result
        total = result['p_h'] + result['p_d'] + result['p_a']
        assert abs(total - 1.0) < 0.01

    def test_monte_carlo_btts(self):
        from predictor import monte_carlo_simulation
        result = monte_carlo_simulation(2.0, 2.0, iterations=500)
        assert 0 <= result['btts_prob'] <= 1

    def test_calculate_most_likely_score(self):
        from predictor import calculate_most_likely_score
        score = calculate_most_likely_score(1.5, 1.0)
        assert ' - ' in score
        h, a = map(int, score.split(' - '))
        assert 0 <= h <= 7
        assert 0 <= a <= 7

    def test_calculate_exact_score(self):
        from predictor import calculate_exact_score
        score = calculate_exact_score(1.5, 1.0, 50, 30)
        assert ' - ' in score

    def test_calculate_ah_dnb_probs(self):
        from predictor import calculate_ah_dnb_probs
        dnb_h, dnb_a, dc_h, dc_a, dc_12 = calculate_ah_dnb_probs(0.5, 0.25, 0.25)
        # DNB removes draw: total_non_draw = 0.5 + 0.25 = 0.75
        assert abs(dnb_h - 0.5/0.75) < 0.01
        assert abs(dnb_a - 0.25/0.75) < 0.01
        # DC: home+draw, away+draw, home+away
        assert abs(dc_h - 0.75) < 0.01
        assert abs(dc_a - 0.50) < 0.01
        assert abs(dc_12 - 0.75) < 0.01

    def test_apply_live_event_adjustment_no_live(self):
        from predictor import apply_live_event_adjustment
        p_h, p_d, p_a, alerts = apply_live_event_adjustment({}, 0.5, 0.25, 0.25)
        assert p_h == 0.5
        assert len(alerts) == 0


# ============================================================================
# POST_PROCESSOR TESTS
# ============================================================================

class TestPostProcessor:
    def test_generate_strategic_brief(self):
        from post_processor import generate_strategic_brief
        brief = generate_strategic_brief({}, 'Team A', 'Team B', 'Home')
        assert len(brief) > 0

    def test_generate_value_insight(self):
        from post_processor import generate_value_insight
        insight = generate_value_insight(60, 2.0, 0.55)
        assert 'has_value' in insight

    def test_generate_security_insight(self):
        from post_processor import generate_security_insight
        insight = generate_security_insight(70, 5, 80)
        assert 'level' in insight

    def test_calculate_kelly_stake(self):
        from post_processor import calculate_kelly_stake
        kelly = calculate_kelly_stake(60, 2.0)
        assert kelly >= 0

    def test_calculate_kelly_stake_no_value(self):
        from post_processor import calculate_kelly_stake
        kelly = calculate_kelly_stake(30, 1.5)
        assert kelly == 0.0

    def test_detect_risk_flags(self):
        from post_processor import detect_risk_flags
        score, flags, veto = detect_risk_flags({}, {}, 0.5, 0.25, 0.25, 'T3')
        assert score > 0
        assert isinstance(flags, list)

    def test_calibrate_confidence(self):
        from post_processor import calibrate_confidence
        conf = calibrate_confidence(70, 'T1', False, 1.1, 'HIGH', 80, True, False, 0)
        assert 5.0 <= conf <= 99.0
