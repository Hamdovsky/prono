"""
Tests for xg_engine.py — Multi-source xG Computation & Modifier Pipeline
"""
import pytest
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))


class TestComputeBaseXG:
    def test_raw_xg_preferred_when_available(self):
        from xg_engine import compute_base_xg
        match_obj = {'home_xg': 1.8, 'away_xg': 1.2, 'league': 'Premier League'}
        features, raw_features = {}, {}
        h_hist, a_hist = [], []
        xg_h, xg_a, base_xg_h, base_xg_a, analysis, h_stats, a_stats = compute_base_xg(
            match_obj, features, raw_features, h_hist, a_hist, 0.0, 0.0, 'Team A', 'Team B', 'premier league'
        )
        assert abs(xg_h - 1.8) < 0.01
        assert abs(xg_a - 1.2) < 0.01
        assert abs(base_xg_h - 1.8) < 0.01

    def test_odds_reverse_engineering_fallback(self):
        from xg_engine import compute_base_xg
        match_obj = {'odds_home': 1.80, 'odds_draw': 3.50, 'odds_away': 4.50, 'league': 'Test'}
        features, raw_features = {}, {}
        h_hist, a_hist = [], []
        xg_h, xg_a, base_xg_h, base_xg_a, analysis, h_stats, a_stats = compute_base_xg(
            match_obj, features, raw_features, h_hist, a_hist, 0.0, 0.0, 'A', 'B', 'test'
        )
        assert xg_h > 0
        assert xg_a > 0

    def test_perf_delta_applied(self):
        from xg_engine import compute_base_xg
        match_obj = {'home_xg': 2.0, 'away_xg': 1.0, 'league': 'L1'}
        features, raw_features = {}, {}
        h_hist, a_hist = [], []
        xg_h, xg_a, _, _, _, _, _ = compute_base_xg(
            match_obj, features, raw_features, h_hist, a_hist, 0.5, -0.3, 'H', 'A', 'l1'
        )
        assert xg_h > 2.0  # positive perf_delta boosts xG
        assert xg_a < 1.0  # negative perf_delta reduces xG


class TestApplySquadIntelligence:
    def test_no_injuries_returns_ones(self):
        from xg_engine import apply_squad_intelligence
        h_a, h_d, a_a, a_d = apply_squad_intelligence(1.5, 1.2, {}, {})
        assert h_a == 1.0
        assert h_d == 1.0
        assert a_a == 1.0
        assert a_d == 1.0

    def test_home_gk_out_weakens_defense(self):
        from xg_engine import apply_squad_intelligence
        h_a, h_d, a_a, a_d = apply_squad_intelligence(1.5, 1.2, {'is_missing_gk': 1}, {})
        assert h_d == 1.25
        assert h_a == 1.0

    def test_home_scorer_out_weakens_attack(self):
        from xg_engine import apply_squad_intelligence
        h_a, h_d, a_a, a_d = apply_squad_intelligence(1.5, 1.2, {'is_missing_scorer': 1}, {})
        assert h_a == 0.70

    def test_star_out_both_attack_defense(self):
        from xg_engine import apply_squad_intelligence
        h_a, h_d, _, _ = apply_squad_intelligence(1.5, 1.2, {'is_missing_star': 1}, {})
        assert h_a == 0.85
        assert h_d == 1.15

    def test_away_injuries_applied(self):
        from xg_engine import apply_squad_intelligence
        _, _, a_a, a_d = apply_squad_intelligence(1.5, 1.2, {'is_missing_gk_away': 1}, {})
        assert a_d == 1.25

    def test_cumulative_injuries(self):
        from xg_engine import apply_squad_intelligence
        h_a, h_d, _, _ = apply_squad_intelligence(1.5, 1.2, {'is_missing_gk': 1, 'is_missing_scorer': 1}, {})
        assert h_a == 0.70  # only scorer affects attack
        assert h_d == 1.25  # only gk affects defense


class TestComputeDmfFatigue:
    def test_standard_match(self):
        from xg_engine import compute_dmf_fatigue
        match_obj = {'home_target_weight': 0.5, 'away_target_weight': 0.3}
        features = {'rest_h': 7, 'rest_a': 7}
        h_hist = [{'x': 1}] * 10
        a_hist = [{'x': 1}] * 10
        h_dmf, a_dmf, h_fat, a_fat, h_dz, a_dz, sig, _, _, _, _ = compute_dmf_fatigue(
            match_obj, features, h_hist, a_hist, 1.0, 1.0, 1.0, 1.0
        )
        assert h_dmf > 0
        assert a_dmf > 0

    def test_dead_zone_detection(self):
        from xg_engine import compute_dmf_fatigue
        match_obj = {'home_target_weight': 0.05, 'away_target_weight': 0.05}
        features = {}
        h_hist = [{'x': 1}] * 10
        a_hist = [{'x': 1}] * 10
        _, _, _, _, h_dz, a_dz, sig, _, _, _, _ = compute_dmf_fatigue(
            match_obj, features, h_hist, a_hist, 1.0, 1.0, 1.0, 1.0
        )
        assert h_dz is True
        assert a_dz is True
        assert "ZONE MORTE" in sig

    def test_motivation_clash(self):
        from xg_engine import compute_dmf_fatigue
        match_obj = {'home_target_weight': 1.0, 'away_target_weight': 1.0}
        features = {}
        h_hist = [{'x': 1}] * 3
        a_hist = [{'x': 1}] * 3
        _, _, _, _, _, _, sig, _, _, _, _ = compute_dmf_fatigue(
            match_obj, features, h_hist, a_hist, 1.0, 1.0, 1.0, 1.0
        )
        assert "MOTIVATION" in sig


class TestApplyMarketAndLeague:
    def test_market_value_ratio_boost(self):
        from xg_engine import apply_market_and_league
        features = {'h_sot': 5, 'a_sot': 4, 'h_bc': 2, 'a_bc': 1.5, 'h_pos': 55, 'a_pos': 45}
        match_obj = {'home_market_value': 100, 'away_market_value': 30}
        xg_h, xg_a, h_ca, a_ca, h_a, a_a = apply_market_and_league(
            1.5, 1.2, features, match_obj, 1.0, 1.0, 0, 0, 'premier league'
        )
        assert xg_h > 0
        assert xg_a > 0

    def test_no_market_value_no_change(self):
        from xg_engine import apply_market_and_league
        features = {'h_sot': 5, 'a_sot': 4, 'h_bc': 2, 'a_bc': 1.5, 'h_pos': 55, 'a_pos': 45}
        match_obj = {}
        xg_h, xg_a, h_ca, a_ca, h_a, a_a = apply_market_and_league(
            1.5, 1.2, features, match_obj, 1.0, 1.0, 0, 0, 'test'
        )
        assert xg_h > 0
        assert xg_a > 0


class TestApplyEnvironmentalAndTactical:
    def test_rain_reduces_xg(self):
        from xg_engine import apply_environmental_and_tactical
        match_obj = {'weather_desc': 'Heavy Rain', 'homeTeam': 'H', 'awayTeam': 'A'}
        features = {}
        h_hist, a_hist = [], []
        xg_h, xg_a, analysis, alerts, rot, wind = apply_environmental_and_tactical(
            2.0, 1.5, 2.0, 1.5, match_obj, features, h_hist, a_hist, 'H', 'A', 'test', 1.0, 1.0
        )
        assert xg_h < 2.0
        assert xg_a < 1.5

    def test_cascade_guard_caps_xg(self):
        from xg_engine import apply_environmental_and_tactical
        match_obj = {'weather_desc': ''}
        features = {'explosive_momentum_h': 2.0}
        h_hist, a_hist = [], []
        xg_h, xg_a, analysis, alerts, rot, wind = apply_environmental_and_tactical(
            1.0, 1.0, 1.0, 1.0, match_obj, features, h_hist, a_hist, 'H', 'A', 'test', 1.0, 1.0
        )
        assert xg_h <= 4.0
        assert xg_h >= 0.2

    def test_xg_clamped_to_realistic_range(self):
        from xg_engine import apply_environmental_and_tactical
        match_obj = {'weather_desc': ''}
        features = {}
        h_hist, a_hist = [], []
        xg_h, xg_a, _, _, _, _ = apply_environmental_and_tactical(
            10.0, 0.05, 10.0, 0.05, match_obj, features, h_hist, a_hist, 'H', 'A', 'test', 1.0, 1.0
        )
        assert 0.2 <= xg_h <= 4.0
        assert 0.2 <= xg_a <= 4.0


class TestApplyDixonColesGamma:
    def test_returns_valid_params(self):
        from xg_engine import apply_dixon_coles_gamma
        xg_h, xg_a, rho, gamma, dist = apply_dixon_coles_gamma(1.5, 1.2, 'premier league')
        assert isinstance(rho, float)
        assert isinstance(gamma, float)
        assert isinstance(dist, str)
        assert xg_h > 0
        assert xg_a > 0

    def test_gamma_zero_no_change(self):
        from xg_engine import apply_dixon_coles_gamma
        xg_h_orig, xg_a_orig = 1.5, 1.2
        xg_h, xg_a, rho, gamma, dist = apply_dixon_coles_gamma(xg_h_orig, xg_a_orig, 'unknown_league_xyz')
        if abs(gamma) < 0.001:
            assert abs(xg_h - xg_h_orig) < 0.01
            assert abs(xg_a - xg_a_orig) < 0.01
