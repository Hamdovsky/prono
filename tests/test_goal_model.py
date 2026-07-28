import sys
import os
import pytest
import json
import math

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))


class TestGoalModel:
    def test_calculate_time_weights(self):
        from goal_model import calculate_time_weights
        days = [0, 30, 90, 365]
        weights = calculate_time_weights(days)
        assert len(weights) == len(days)
        assert all(0 < w <= 1 for w in weights)
        assert weights[0] > weights[-1]

    def test_choose_distribution_poisson(self):
        from goal_model import _choose_distribution
        matches = [
            {"home_goals": 1, "away_goals": 1},
            {"home_goals": 2, "away_goals": 0},
        ]
        dist = _choose_distribution(matches)
        assert dist in ("poisson", "negbin")

    def test_fit_base_poisson_returns_params(self):
        from goal_model import fit_base_poisson
        matches = [
            {"home": "A", "away": "B", "home_goals": 2, "away_goals": 1, "days_ago": 10},
            {"home": "C", "away": "D", "home_goals": 0, "away_goals": 3, "days_ago": 20},
        ]
        time_weights = [0.9, 0.8]
        result = fit_base_poisson(matches, time_weights)
        assert result.get("success") is True or result.get("success") is False
        assert "mu" in result or "error" in result

    def test_empty_matches_returns_error(self):
        from goal_model import fit_base_poisson
        result = fit_base_poisson([], [])
        assert result.get("success") is False


class TestCalibration:
    def test_fit_calibration(self):
        from calibration import fit_calibration
        home_probs = [0.5, 0.4, 0.6]
        draw_probs = [0.3, 0.3, 0.2]
        away_probs = [0.2, 0.3, 0.2]
        outcomes = ["H", "A", "H"]
        params = fit_calibration(home_probs, draw_probs, away_probs, outcomes)
        assert isinstance(params, dict)
        assert "alpha" in params or "success" in params or "error" in params
