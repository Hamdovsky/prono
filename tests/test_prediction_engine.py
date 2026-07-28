import sys
import os
import json
import pytest
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))


class TestPredictionEngine:
    def test_convert_numpy_types(self):
        from fastapi_server import convert_numpy
        assert convert_numpy(np.int64(42)) == 42
        assert convert_numpy(np.float64(3.14)) == 3.14
        assert convert_numpy(np.array([1, 2, 3])) == [1, 2, 3]
        assert convert_numpy(np.bool_(True)) is True
        assert convert_numpy({'a': np.int64(1), 'b': [np.float64(2.0)]}) == {'a': 1, 'b': [2.0]}

    def test_clean_data_with_string_fullData(self):
        from fastapi_server import clean_data
        result = clean_data({"fullData": '{"homeTeam": "PSG"}'})
        assert result.get("homeTeam") == "PSG"

    def test_clean_data_with_dict_fullData(self):
        from fastapi_server import clean_data
        result = clean_data({"fullData": {"homeTeam": "OM"}})
        assert result.get("homeTeam") == "OM"

    def test_clean_data_with_malformed_json(self):
        from fastapi_server import clean_data
        result = clean_data({"fullData": "{invalid json", "homeTeam": "LYON"})
        assert result.get("homeTeam") == "LYON"

    def test_health_check_returns_status(self):
        from fastapi_server import app
        client = pytest.importorskip("httpx").AsyncClient
        import asyncio
        async def _test():
            async with client(app=app, base_url="http://test") as ac:
                resp = await ac.get("/health")
                assert resp.status_code == 200
                data = resp.json()
                assert data["status"] == "healthy"
                assert "version" in data
        asyncio.run(_test())


class TestDataCleaner:
    def test_clean_league_name(self):
        from data_cleaner import clean_league_name
        result = clean_league_name("Ligue 1 Uber Eats")
        assert result is not None

    def test_clean_team_name(self):
        from data_cleaner import clean_team_name
        result = clean_team_name("Paris Saint-Germain")
        assert result is not None


class TestFeatureEngineer:
    def test_feature_extraction_returns_dict(self):
        from feature_engineer import extract_features
        match = {"homeTeam": "PSG", "awayTeam": "OM", "league": "Ligue 1"}
        result = extract_features(match)
        assert isinstance(result, dict)

    def test_feature_count(self):
        from feature_analyzer import analyze_features
        match = {"homeTeam": "PSG", "awayTeam": "OM", "league": "Ligue 1"}
        result = analyze_features(match)
        assert isinstance(result, dict)
