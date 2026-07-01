"""
Tests d'intégration pour le pipeline de prédiction complet
Tests end-to-end: match_obj -> prediction_engine -> verdict final
"""
import pytest
import sys
import os
from unittest.mock import patch
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

from prediction_engine import process_prediction


class TestPredictionPipelineIntegration:
    @pytest.fixture
    def sample_match_t1(self):
        return {
            'id': 12345,
            'homeTeam': 'Manchester City',
            'awayTeam': 'Arsenal',
            'league': 'Premier League',
            'country': 'England',
            'startTimestamp': 1735689600,
            'status': 'scheduled',
            'home_xg': 2.5,
            'away_xg': 1.8,
            'odds_home': 1.80,
            'odds_draw': 3.50,
            'odds_away': 4.50
        }

    @pytest.fixture
    def sample_match_t2(self):
        return {
            'id': 67890,
            'homeTeam': 'PSG',
            'awayTeam': 'Lyon',
            'league': 'Ligue 1',
            'country': 'France',
            'startTimestamp': 1735689600,
            'status': 'scheduled',
            'home_xg': 2.2,
            'away_xg': 1.5,
            'odds_home': 1.70,
            'odds_draw': 3.80,
            'odds_away': 4.50
        }

    @pytest.fixture
    def sample_match_t3(self):
        return {
            'id': 11111,
            'homeTeam': 'Club A',
            'awayTeam': 'Club B',
            'league': 'Segunda Division',
            'country': 'Spain',
            'startTimestamp': 1735689600,
            'status': 'scheduled',
            'odds_home': 2.20,
            'odds_draw': 3.30,
            'odds_away': 3.00
        }

    def test_pipeline_t1_match_complete(self, sample_match_t1):
        result = process_prediction(sample_match_t1)
        assert isinstance(result, dict)
        assert result.get('success') is True or 'verdict' in result

    def test_pipeline_t2_match(self, sample_match_t2):
        result = process_prediction(sample_match_t2)
        assert isinstance(result, dict)
        assert result.get('success') is True or 'verdict' in result

    def test_pipeline_t3_match(self, sample_match_t3):
        result = process_prediction(sample_match_t3)
        assert isinstance(result, dict)

    def test_pipeline_expected_score(self, sample_match_t1):
        result = process_prediction(sample_match_t1)
        assert 'expected_score' in result
        score = result['expected_score']
        assert ' - ' in str(score)

    def test_pipeline_probabilities(self, sample_match_t1):
        result = process_prediction(sample_match_t1)
        assert 'home_win_probability' in result
        assert 'draw_probability' in result
        assert 'away_win_probability' in result
        total = result['home_win_probability'] + result['draw_probability'] + result['away_win_probability']
        assert 0.5 < total < 2.0

    def test_pipeline_verdict(self, sample_match_t1):
        result = process_prediction(sample_match_t1)
        assert 'verdict' in result

    def test_pipeline_home_favorite(self):
        match = {
            'homeTeam': 'Barcelona',
            'awayTeam': 'Getafe',
            'league': 'LaLiga',
            'country': 'Spain',
            'home_xg': 3.0,
            'away_xg': 0.5,
            'odds_home': 1.15,
            'odds_draw': 8.00,
            'odds_away': 15.00
        }
        result = process_prediction(match)
        assert isinstance(result, dict)

    def test_pipeline_away_favorite(self):
        match = {
            'homeTeam': 'Luton Town',
            'awayTeam': 'Manchester City',
            'league': 'Premier League',
            'country': 'England',
            'home_xg': 0.5,
            'away_xg': 3.0,
            'odds_home': 8.00,
            'odds_draw': 4.50,
            'odds_away': 1.35
        }
        result = process_prediction(match)
        assert isinstance(result, dict)

    def test_pipeline_balanced_match(self):
        match = {
            'homeTeam': 'Real Madrid',
            'awayTeam': 'Bayern Munich',
            'league': 'Champions League',
            'country': 'Europe',
            'home_xg': 1.8,
            'away_xg': 1.6,
            'odds_home': 2.20,
            'odds_draw': 3.40,
            'odds_away': 3.00
        }
        result = process_prediction(match)
        assert isinstance(result, dict)

    def test_pipeline_missing_xg(self):
        match = {
            'homeTeam': 'Team A',
            'awayTeam': 'Team B',
            'league': 'Ligue 2',
            'country': 'France'
        }
        result = process_prediction(match)
        assert isinstance(result, dict)

    def test_pipeline_risk_assessment(self, sample_match_t1):
        result = process_prediction(sample_match_t1)
        if 'risk_score' in result:
            assert 0 <= result['risk_score'] <= 100

    def test_pipeline_confidence_calculation(self, sample_match_t1):
        result = process_prediction(sample_match_t1)
        if 'surgical_confidence' in result:
            conf = result['surgical_confidence']
            assert isinstance(conf, (int, float))
            assert 0 <= conf <= 100


class TestPredictionPipelineErrorHandling:
    @pytest.fixture
    def sample_match(self):
        return {
            'homeTeam': 'Team A',
            'awayTeam': 'Team B',
            'league': 'Premier League',
            'odds_home': 2.0,
            'odds_draw': 3.0,
            'odds_away': 4.0
        }

    def test_pipeline_handles_empty_dict(self):
        result = process_prediction({})
        assert isinstance(result, dict)

    def test_pipeline_handles_minimal_data(self):
        result = process_prediction({'homeTeam': 'A', 'awayTeam': 'B'})
        assert isinstance(result, dict)

    def test_pipeline_handles_invalid_odds(self):
        match = {
            'homeTeam': 'A',
            'awayTeam': 'B',
            'league': 'Test',
            'odds_home': -1.0,
            'odds_draw': 0.0,
            'odds_away': 2.0
        }
        result = process_prediction(match)
        assert isinstance(result, dict)


if __name__ == '__main__':
    pytest.main([__file__, '-v', '--tb=short'])
