"""
Tests unitaires pour goal_model.py
Coverage: distributions Poisson, Dixon-Coles, Monte Carlo, marchés BTTS/O-U
"""
import pytest
import numpy as np
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

from goal_model import (
    poisson_pmf,
    get_dixon_coles_adjustment,
    monte_carlo_simulation_goalmodel,
    predict_btts,
    predict_ou,
    calculate_most_likely_score_goalmodel
)


class TestPoissonPMF:
    def test_poisson_zero_goals(self):
        prob = poisson_pmf(1.5, 0)
        expected = np.exp(-1.5)
        assert abs(prob - expected) < 0.0001

    def test_poisson_one_goal(self):
        prob = poisson_pmf(2.0, 1)
        expected = 2.0 * np.exp(-2.0)
        assert abs(prob - expected) < 0.0001

    def test_poisson_high_goals(self):
        prob = poisson_pmf(1.2, 5)
        assert 0 < prob < 0.1
        assert isinstance(prob, float)

    def test_poisson_zero_lambda(self):
        assert poisson_pmf(0.0, 0) == 1.0
        assert poisson_pmf(0.0, 1) == 0.0

    def test_poisson_high_lambda(self):
        prob = poisson_pmf(5.0, 3)
        assert 0 < prob < 1
        assert isinstance(prob, float)


class TestDixonColesAdjustment:
    def test_adjustment_0_0(self):
        adj = get_dixon_coles_adjustment(1.5, 1.2, 0, 0, rho=-0.12)
        assert adj != 1.0
        assert adj > 0

    def test_adjustment_1_0(self):
        adj = get_dixon_coles_adjustment(1.5, 1.2, 1, 0, rho=-0.12)
        assert adj != 1.0
        assert adj > 0

    def test_adjustment_0_1(self):
        adj = get_dixon_coles_adjustment(1.5, 1.2, 0, 1, rho=-0.12)
        assert adj != 1.0
        assert adj > 0

    def test_adjustment_1_1(self):
        adj = get_dixon_coles_adjustment(1.5, 1.2, 1, 1, rho=-0.12)
        assert adj != 1.0
        assert adj > 0

    def test_adjustment_high_score(self):
        adj = get_dixon_coles_adjustment(1.5, 1.2, 3, 2, rho=-0.12)
        assert adj == 1.0

    def test_adjustment_rho_zero(self):
        adj = get_dixon_coles_adjustment(1.5, 1.2, 0, 0, rho=0.0)
        assert adj == 1.0


class TestMonteCarloSimulation:
    def test_simulation_basic(self):
        result = monte_carlo_simulation_goalmodel(2.0, 1.5)
        assert 'p_h' in result
        assert 'p_d' in result
        assert 'p_a' in result
        total_prob = result['p_h'] + result['p_d'] + result['p_a']
        assert abs(total_prob - 1.0) < 0.01

    def test_simulation_home_favorite(self):
        result = monte_carlo_simulation_goalmodel(3.0, 0.8)
        assert result['p_h'] > result['p_d']
        assert result['p_h'] > result['p_a']

    def test_simulation_away_favorite(self):
        result = monte_carlo_simulation_goalmodel(0.8, 3.0)
        assert result['p_a'] > result['p_d']
        assert result['p_a'] > result['p_h']

    def test_simulation_balanced(self):
        result = monte_carlo_simulation_goalmodel(1.5, 1.5)
        assert abs(result['p_h'] - result['p_a']) < 0.1

    def test_simulation_score_distribution(self):
        result = monte_carlo_simulation_goalmodel(2.0, 1.5)
        assert 'avg_total_goals' in result
        assert isinstance(result['avg_total_goals'], float)

    def test_simulation_zero_xg(self):
        result = monte_carlo_simulation_goalmodel(0.0, 0.0)
        assert result['p_d'] > 0.8

    def test_simulation_btts(self):
        result = monte_carlo_simulation_goalmodel(2.0, 2.0)
        assert 0 <= result['btts_prob'] <= 1

    def test_simulation_ou(self):
        result = monte_carlo_simulation_goalmodel(2.0, 1.5)
        assert 0 <= result['ou_25_prob'] <= 1


class TestBTTSPrediction:
    def test_btts_high_xg(self):
        prob = predict_btts(2.5, 2.0)
        assert prob > 0.5
        assert 0 <= prob <= 1

    def test_btts_low_xg(self):
        prob = predict_btts(0.5, 0.5)
        assert prob < 0.5
        assert 0 <= prob <= 1

    def test_btts_zero_xg(self):
        prob = predict_btts(0.0, 0.0)
        assert prob < 0.1


class TestOverUnderPrediction:
    def test_ou_2_5_high_xg(self):
        result = predict_ou(2.5, 2.0, threshold=2.5)
        assert isinstance(result, float)
        assert 0 <= result <= 1

    def test_ou_2_5_low_xg(self):
        result = predict_ou(0.8, 0.8, threshold=2.5)
        assert isinstance(result, float)
        assert 0 <= result <= 1

    def test_ou_1_5(self):
        result = predict_ou(1.5, 1.5, threshold=1.5)
        assert isinstance(result, float)
        assert 0 <= result <= 1

    def test_ou_3_5(self):
        result = predict_ou(2.0, 2.0, threshold=3.5)
        assert isinstance(result, float)
        assert 0 <= result <= 1


class TestMostLikelyScore:
    def test_most_likely_balanced(self):
        result = calculate_most_likely_score_goalmodel(1.5, 1.5)
        assert isinstance(result, str)
        assert ' - ' in result

    def test_most_likely_home_favorite(self):
        result = calculate_most_likely_score_goalmodel(2.5, 1.0)
        h, a = map(int, result.split(' - '))
        assert h >= a - 1

    def test_most_likely_away_favorite(self):
        result = calculate_most_likely_score_goalmodel(1.0, 2.5)
        h, a = map(int, result.split(' - '))
        assert a >= h - 1

    def test_most_likely_low_xg(self):
        result = calculate_most_likely_score_goalmodel(0.5, 0.5)
        h, a = map(int, result.split(' - '))
        assert h <= 1
        assert a <= 1


class TestEdgeCases:
    def test_negative_xg(self):
        result = monte_carlo_simulation_goalmodel(-1.0, 1.5)
        assert result is not None
        total = result['p_h'] + result['p_d'] + result['p_a']
        assert abs(total - 1.0) < 0.01

    def test_very_high_xg(self):
        result = monte_carlo_simulation_goalmodel(5.0, 5.0)
        total = result['p_h'] + result['p_d'] + result['p_a']
        assert abs(total - 1.0) < 0.01

    def test_small_simulation_count(self):
        result = monte_carlo_simulation_goalmodel(2.0, 1.5, iterations=10)
        assert 'p_h' in result

    def test_large_simulation_count(self):
        result = monte_carlo_simulation_goalmodel(2.0, 1.5, iterations=50000)
        total = result['p_h'] + result['p_d'] + result['p_a']
        assert abs(total - 1.0) < 0.001


if __name__ == '__main__':
    pytest.main([__file__, '-v', '--tb=short'])
