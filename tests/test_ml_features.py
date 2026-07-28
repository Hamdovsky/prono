import sys
import os
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))


class TestMLFeatures:
    def test_extract_features_basic(self):
        from ml_features import extract_features
        match = {
            "homeTeam": "PSG",
            "awayTeam": "OM",
            "league": "Ligue 1",
            "startTimestamp": 1800000000,
        }
        features = extract_features(match)
        assert isinstance(features, dict)
        assert len(features) > 0

    def test_extract_features_with_odds(self):
        from ml_features import extract_features
        match = {
            "homeTeam": "PSG",
            "awayTeam": "OM",
            "league": "Ligue 1",
            "odds_home": 1.5,
            "odds_draw": 4.0,
            "odds_away": 6.0,
        }
        features = extract_features(match)
        assert isinstance(features, dict)

    def test_feature_names(self):
        from ml_features import FEATURE_NAMES
        assert isinstance(FEATURE_NAMES, (list, tuple))
        assert len(FEATURE_NAMES) > 0

    def test_feature_count(self):
        from ml_features import FEATURE_COUNT
        assert FEATURE_COUNT > 0
