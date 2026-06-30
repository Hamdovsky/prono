"""
Tests unitaires pour ml_features.py
Module critique : 1591 lignes, 115+ features
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

import pytest
from unittest.mock import Mock, patch, MagicMock
import numpy as np

# Import functions to test
try:
    from ml_features import (
        _safe_float,
        calculate_elo_rating,
        calculate_form_score,
        calculate_rolling_averages,
        extract_ml_features
    )
    ML_FEATURES_AVAILABLE = True
except ImportError as e:
    ML_FEATURES_AVAILABLE = False
    print(f"Warning: ml_features not available: {e}")


@pytest.mark.skipif(not ML_FEATURES_AVAILABLE, reason="ml_features module not available")
class TestSafeFloat:
    """Tests pour la fonction _safe_float"""
    
    def test_safe_float_valid_int(self):
        """Should convert integer to float"""
        assert _safe_float(5) == 5.0
        assert _safe_float(0) == 0.0
        assert _safe_float(-10) == -10.0
    
    def test_safe_float_valid_float(self):
        """Should handle float values"""
        assert _safe_float(5.5) == 5.5
        assert _safe_float(0.0) == 0.0
        assert _safe_float(-3.14) == -3.14
    
    def test_safe_float_string_number(self):
        """Should parse string numbers"""
        assert _safe_float("5.5") == 5.5
        assert _safe_float("0") == 0.0
        assert _safe_float("-10.5") == -10.5
    
    def test_safe_float_none(self):
        """Should return default for None"""
        assert _safe_float(None) == 0.0
        assert _safe_float(None, default=10.0) == 10.0
    
    def test_safe_float_nan_strings(self):
        """Should handle NaN-like strings"""
        assert _safe_float("nan") == 0.0
        assert _safe_float("NaN") == 0.0
        assert _safe_float("null") == 0.0
        assert _safe_float("") == 0.0
    
    def test_safe_float_invalid(self):
        """Should return default for invalid input"""
        assert _safe_float("abc") == 0.0
        assert _safe_float("abc", default=5.0) == 5.0
        assert _safe_float([1, 2, 3]) == 0.0
        assert _safe_float({}) == 0.0


@pytest.mark.skipif(not ML_FEATURES_AVAILABLE, reason="ml_features module not available")
class TestEloRating:
    """Tests pour calculate_elo_rating"""
    
    def test_elo_rating_basic(self):
        """Should calculate basic Elo rating"""
        # Home win
        elo = calculate_elo_rating(
            home_elo=1500,
            away_elo=1500,
            home_score=2,
            away_score=0,
            k_factor=32
        )
        assert elo['home_elo_new'] > 1500  # Home should gain
        assert elo['away_elo_new'] < 1500  # Away should lose
    
    def test_elo_rating_draw(self):
        """Should handle draw correctly"""
        elo = calculate_elo_rating(
            home_elo=1500,
            away_elo=1500,
            home_score=1,
            away_score=1,
            k_factor=32
        )
        # In a draw between equal teams, ratings should stay similar
        assert abs(elo['home_elo_new'] - 1500) < 5
        assert abs(elo['away_elo_new'] - 1500) < 5
    
    def test_elo_rating_upset(self):
        """Should handle upset (weak team beats strong team)"""
        elo = calculate_elo_rating(
            home_elo=1300,  # Weak team
            away_elo=1700,  # Strong team
            home_score=2,
            away_score=0,
            k_factor=32
        )
        # Home (weak) should gain a lot
        assert elo['home_elo_new'] > 1300 + 20
        # Away (strong) should lose a lot
        assert elo['away_elo_new'] < 1700 - 20
    
    def test_elo_rating_expected_win(self):
        """Should handle expected win (strong beats weak)"""
        elo = calculate_elo_rating(
            home_elo=1700,  # Strong team
            away_elo=1300,  # Weak team
            home_score=3,
            away_score=0,
            k_factor=32
        )
        # Home should gain less (expected win)
        gain = elo['home_elo_new'] - 1700
        assert 0 < gain < 20


@pytest.mark.skipif(not ML_FEATURES_AVAILABLE, reason="ml_features module not available")
class TestFormScore:
    """Tests pour calculate_form_score"""
    
    def test_form_score_all_wins(self):
        """Should calculate high form for all wins"""
        matches = [
            {'homeGoals': 3, 'awayGoals': 0, 'isHome': True},
            {'homeGoals': 2, 'awayGoals': 1, 'isHome': True},
            {'homeGoals': 1, 'awayGoals': 0, 'isHome': True},
        ]
        form = calculate_form_score(matches, team='home')
        assert form > 2.5  # 3 wins = high form
    
    def test_form_score_all_losses(self):
        """Should calculate low form for all losses"""
        matches = [
            {'homeGoals': 0, 'awayGoals': 3, 'isHome': True},
            {'homeGoals': 1, 'awayGoals': 2, 'isHome': True},
            {'homeGoals': 0, 'awayGoals': 1, 'isHome': True},
        ]
        form = calculate_form_score(matches, team='home')
        assert form < 1.0  # 3 losses = low form
    
    def test_form_score_draws(self):
        """Should calculate medium form for draws"""
        matches = [
            {'homeGoals': 1, 'awayGoals': 1, 'isHome': True},
            {'homeGoals': 0, 'awayGoals': 0, 'isHome': True},
            {'homeGoals': 2, 'awayGoals': 2, 'isHome': True},
        ]
        form = calculate_form_score(matches, team='home')
        assert 1.0 < form < 2.0  # Draws = medium form
    
    def test_form_score_empty_matches(self):
        """Should handle empty match history"""
        matches = []
        form = calculate_form_score(matches, team='home')
        assert form == 1.5  # Default neutral form


@pytest.mark.skipif(not ML_FEATURES_AVAILABLE, reason="ml_features module not available")
class TestRollingAverages:
    """Tests pour calculate_rolling_averages"""
    
    def test_rolling_averages_basic(self):
        """Should calculate rolling averages"""
        matches = [
            {'homeGoals': 2, 'awayGoals': 1, 'isHome': True, 'xG': 2.5},
            {'homeGoals': 1, 'awayGoals': 0, 'isHome': True, 'xG': 1.8},
            {'homeGoals': 3, 'awayGoals': 2, 'isHome': True, 'xG': 2.2},
        ]
        
        avg = calculate_rolling_averages(matches, window=3)
        
        assert 'avg_goals_scored' in avg
        assert 'avg_goals_conceded' in avg
        assert 'avg_xg' in avg
        
        # Average goals scored = (2+1+3)/3 = 2.0
        assert abs(avg['avg_goals_scored'] - 2.0) < 0.1
        
        # Average goals conceded = (1+0+2)/3 = 1.0
        assert abs(avg['avg_goals_conceded'] - 1.0) < 0.1
    
    def test_rolling_averages_window_size(self):
        """Should respect window size"""
        matches = [
            {'homeGoals': 5, 'awayGoals': 0, 'isHome': True},  # Old
            {'homeGoals': 0, 'awayGoals': 0, 'isHome': True},  # Recent
            {'homeGoals': 0, 'awayGoals': 0, 'isHome': True},  # Recent
        ]
        
        # Window=2 should only consider last 2 matches
        avg = calculate_rolling_averages(matches, window=2)
        assert avg['avg_goals_scored'] == 0.0  # Only last 2 (0+0)/2
    
    def test_rolling_averages_empty(self):
        """Should handle empty matches"""
        matches = []
        avg = calculate_rolling_averages(matches, window=5)
        
        assert avg['avg_goals_scored'] == 0.0
        assert avg['avg_goals_conceded'] == 0.0


@pytest.mark.skipif(not ML_FEATURES_AVAILABLE, reason="ml_features module not available")
class TestExtractMLFeatures:
    """Tests pour extract_ml_features (fonction principale)"""
    
    def test_extract_ml_features_basic(self):
        """Should extract basic features from match"""
        match = {
            'homeTeam': 'Team A',
            'awayTeam': 'Team B',
            'league': 'Premier League',
            'home_xg': 1.5,
            'away_xg': 1.2,
            'odds_home': 2.0,
            'odds_draw': 3.5,
            'odds_away': 3.0,
        }
        
        features = extract_ml_features(match)
        
        assert isinstance(features, dict)
        assert len(features) > 10  # Should have many features
        
        # Check key features exist
        assert 'home_xg' in features or 'xg_home' in features
        assert 'away_xg' in features or 'xg_away' in features
    
    def test_extract_ml_features_missing_data(self):
        """Should handle missing data gracefully"""
        match = {
            'homeTeam': 'Team A',
            'awayTeam': 'Team B',
            # Missing xG, odds, etc.
        }
        
        features = extract_ml_features(match)
        
        assert isinstance(features, dict)
        # Should have defaults for missing values
        assert 'home_xg' in features or 'xg_home' in features
    
    def test_extract_ml_features_invalid_data(self):
        """Should handle invalid data"""
        match = {
            'homeTeam': 'Team A',
            'awayTeam': 'Team B',
            'home_xg': 'invalid',  # Invalid type
            'odds_home': None,     # None value
        }
        
        features = extract_ml_features(match)
        
        assert isinstance(features, dict)
        # Should convert invalid to defaults


@pytest.mark.skipif(not ML_FEATURES_AVAILABLE, reason="ml_features module not available")
class TestEdgeCases:
    """Tests pour cas limites et edge cases"""
    
    def test_extreme_elo_values(self):
        """Should handle extreme Elo ratings"""
        elo = calculate_elo_rating(
            home_elo=2500,  # Very high
            away_elo=800,   # Very low
            home_score=5,
            away_score=0,
            k_factor=32
        )
        
        # Should not overflow
        assert elo['home_elo_new'] < 3000
        assert elo['away_elo_new'] > 0
    
    def test_zero_k_factor(self):
        """Should handle zero K-factor"""
        elo = calculate_elo_rating(
            home_elo=1500,
            away_elo=1500,
            home_score=2,
            away_score=0,
            k_factor=0  # No change
        )
        
        # Ratings should not change
        assert elo['home_elo_new'] == 1500
        assert elo['away_elo_new'] == 1500
    
    def test_very_large_score(self):
        """Should handle very large scores"""
        form = calculate_form_score([
            {'homeGoals': 10, 'awayGoals': 0, 'isHome': True},
        ], team='home')
        
        # Should be high but not infinite
        assert form > 2.5
        assert form < 10.0


if __name__ == '__main__':
    pytest.main([__file__, '-v', '--tb=short'])
