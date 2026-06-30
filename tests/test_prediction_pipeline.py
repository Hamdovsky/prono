"""
Tests d'intégration pour le pipeline de prédiction complet
Tests end-to-end: match_obj -> prediction_engine -> verdict final
"""
import pytest
import sys
import os
from unittest.mock import patch, MagicMock, Mock
import json

# Add core/ to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

from prediction_engine import process_prediction


class TestPredictionPipelineIntegration:
    """Tests d'intégration du pipeline complet"""
    
    @pytest.fixture
    def sample_match_t1(self):
        """Match de Premier League (T1)"""
        return {
            'id': 12345,
            'homeTeam': 'Manchester City',
            'awayTeam': 'Arsenal',
            'league': 'Premier League',
            'country': 'England',
            'startTimestamp': 1735689600,
            'status': 'scheduled',
            'home_xg': 2.5,
            'away_xg': 1.8
        }
    
    @pytest.fixture
    def sample_match_t2(self):
        """Match de Ligue 1 (T2)"""
        return {
            'id': 67890,
            'homeTeam': 'PSG',
            'awayTeam': 'Lyon',
            'league': 'Ligue 1',
            'country': 'France',
            'startTimestamp': 1735689600,
            'status': 'scheduled',
            'home_xg': 2.2,
            'away_xg': 1.5
        }
    
    @pytest.fixture
    def sample_match_t3(self):
        """Match de division inférieure (T3)"""
        return {
            'id': 11111,
            'homeTeam': 'Club A',
            'awayTeam': 'Club B',
            'league': 'Segunda Division',
            'country': 'Spain',
            'startTimestamp': 1735689600,
            'status': 'scheduled'
        }
    
    def test_pipeline_t1_match_complete(self, sample_match_t1):
        """Test pipeline complet pour match T1"""
        result = process_prediction(sample_match_t1)
        
        # Structure de base
        assert isinstance(result, dict)
        assert 'verdict' in result
        assert 'confidence' in result
        assert 'selection' in result
        assert 'probabilities' in result
        
        # Verdicts valides
        valid_verdicts = [
            'SAFE BET', 'STRONG BET', 'MEDIUM BET',
            'RISKY', 'SKIP', 'NO PREDICTION'
        ]
        assert result['verdict'] in valid_verdicts
        
        # Confidence range
        assert 0 <= result['confidence'] <= 100
        
        # Selection valide
        assert result['selection'] in ['Home', 'Draw', 'Away', None]
        
        # Probabilities
        probs = result['probabilities']
        assert 'home' in probs
        assert 'draw' in probs
        assert 'away' in probs
        assert abs(probs['home'] + probs['draw'] + probs['away'] - 1.0) < 0.01
    
    def test_pipeline_expected_score(self, sample_match_t1):
        """Test que le score attendu est calculé"""
        result = process_prediction(sample_match_t1)
        
        assert 'expected_score' in result
        assert isinstance(result['expected_score'], list)
        assert len(result['expected_score']) == 2
        assert all(isinstance(x, (int, float)) for x in result['expected_score'])
    
    def test_pipeline_surgical_markets(self, sample_match_t1):
        """Test que les marchés chirurgicaux sont générés"""
        result = process_prediction(sample_match_t1)
        
        if 'surgical_markets' in result:
            assert isinstance(result['surgical_markets'], list)
            
            if len(result['surgical_markets']) > 0:
                market = result['surgical_markets'][0]
                assert 'type' in market
                assert 'probability' in market or 'value' in market
    
    def test_pipeline_home_favorite(self):
        """Test prédiction pour home très favori"""
        match = {
            'id': 99999,
            'homeTeam': 'Bayern Munich',
            'awayTeam': 'Weak Team',
            'league': 'Bundesliga',
            'country': 'Germany',
            'startTimestamp': 1735689600,
            'home_xg': 3.5,
            'away_xg': 0.8
        }
        
        result = process_prediction(match)
        
        # Home doit avoir la plus forte probabilité
        probs = result['probabilities']
        assert probs['home'] > probs['draw']
        assert probs['home'] > probs['away']
    
    def test_pipeline_away_favorite(self):
        """Test prédiction pour away très favori"""
        match = {
            'id': 88888,
            'homeTeam': 'Weak Team',
            'awayTeam': 'Real Madrid',
            'league': 'La Liga',
            'country': 'Spain',
            'startTimestamp': 1735689600,
            'home_xg': 0.8,
            'away_xg': 3.5
        }
        
        result = process_prediction(match)
        
        # Away doit avoir la plus forte probabilité
        probs = result['probabilities']
        assert probs['away'] > probs['home']
        assert probs['away'] > probs['draw']
    
    def test_pipeline_balanced_match(self):
        """Test prédiction pour match équilibré"""
        match = {
            'id': 77777,
            'homeTeam': 'Team A',
            'awayTeam': 'Team B',
            'league': 'Serie A',
            'country': 'Italy',
            'startTimestamp': 1735689600,
            'home_xg': 1.8,
            'away_xg': 1.8
        }
        
        result = process_prediction(match)
        
        probs = result['probabilities']
        # Home et Away doivent être proches
        assert abs(probs['home'] - probs['away']) < 0.2
    
    def test_pipeline_missing_xg(self, sample_match_t3):
        """Test pipeline avec xG manquants"""
        # Supprimer home_xg et away_xg
        match = sample_match_t3.copy()
        match.pop('home_xg', None)
        match.pop('away_xg', None)
        
        result = process_prediction(match)
        
        # Doit quand même retourner une prédiction
        assert 'verdict' in result
        assert 'confidence' in result
    
    def test_pipeline_invalid_match(self):
        """Test pipeline avec match invalide"""
        invalid_match = {
            'id': 00000,
            # Manque homeTeam, awayTeam, league
        }
        
        result = process_prediction(invalid_match)
        
        # Doit gérer l'erreur gracieusement
        assert result is not None
        assert 'verdict' in result or 'error' in result
    
    def test_pipeline_with_options(self, sample_match_t1):
        """Test pipeline avec options personnalisées"""
        options = {
            'use_monte_carlo': True,
            'n_simulations': 5000,
            'use_deepseek': False
        }
        
        result = process_prediction(sample_match_t1, options=options)
        
        assert result is not None
        assert 'verdict' in result
    
    def test_pipeline_confidence_calculation(self, sample_match_t1):
        """Test que la confiance est cohérente avec le verdict"""
        result = process_prediction(sample_match_t1)
        
        verdict = result['verdict']
        confidence = result['confidence']
        
        # Safe bet -> haute confiance
        if verdict == 'SAFE BET':
            assert confidence >= 70
        
        # Strong bet -> confiance moyenne-haute
        elif verdict == 'STRONG BET':
            assert confidence >= 60
        
        # Skip -> faible confiance
        elif verdict == 'SKIP':
            assert confidence < 60


class TestPredictionPipelinePerformance:
    """Tests de performance du pipeline"""
    
    def test_pipeline_execution_time(self, sample_match_t1):
        """Test que la prédiction s'exécute en temps raisonnable"""
        import time
        
        start = time.time()
        result = process_prediction(sample_match_t1)
        duration = time.time() - start
        
        # Doit s'exécuter en moins de 5 secondes
        assert duration < 5.0
        assert result is not None
    
    def test_pipeline_memory_usage(self, sample_match_t1):
        """Test que le pipeline ne consomme pas trop de RAM"""
        import psutil
        import os
        
        process = psutil.Process(os.getpid())
        mem_before = process.memory_info().rss / 1024 / 1024  # MB
        
        result = process_prediction(sample_match_t1)
        
        mem_after = process.memory_info().rss / 1024 / 1024  # MB
        mem_increase = mem_after - mem_before
        
        # Ne doit pas augmenter de plus de 200MB
        assert mem_increase < 200
        assert result is not None


class TestPredictionPipelineErrorHandling:
    """Tests de gestion d'erreurs"""
    
    def test_pipeline_handles_none_input(self):
        """Test pipeline avec input None"""
        result = process_prediction(None)
        
        # Doit retourner un résultat d'erreur
        assert result is not None
        assert 'error' in result or 'verdict' in result
    
    def test_pipeline_handles_empty_dict(self):
        """Test pipeline avec dictionnaire vide"""
        result = process_prediction({})
        
        assert result is not None
    
    def test_pipeline_handles_missing_required_fields(self):
        """Test pipeline avec champs obligatoires manquants"""
        match = {
            'id': 12345,
            # Manque homeTeam, awayTeam
            'league': 'Test League'
        }
        
        result = process_prediction(match)
        
        assert result is not None
    
    @patch('prediction_engine.get_xgb')
    def test_pipeline_handles_model_error(self, mock_get_xgb, sample_match_t1):
        """Test pipeline quand le modèle échoue"""
        mock_get_xgb.side_effect = Exception("Model loading failed")
        
        result = process_prediction(sample_match_t1)
        
        # Doit retourner un fallback
        assert result is not None
        assert 'verdict' in result or 'error' in result


class TestPredictionPipelineDataFlow:
    """Tests du flux de données dans le pipeline"""
    
    def test_pipeline_feature_extraction(self, sample_match_t1):
        """Test que les features sont extraites correctement"""
        with patch('prediction_engine.extract_ml_features') as mock_extract:
            mock_extract.return_value = {'feature1': 1.0, 'feature2': 2.0}
            
            result = process_prediction(sample_match_t1)
            
            # extract_ml_features doit être appelé
            mock_extract.assert_called()
    
    def test_pipeline_model_prediction(self, sample_match_t1):
        """Test que le modèle fait une prédiction"""
        result = process_prediction(sample_match_t1)
        
        # Doit avoir des probabilités prédites
        assert 'probabilities' in result
        probs = result['probabilities']
        assert all(0 <= probs[k] <= 1 for k in ['home', 'draw', 'away'])
    
    def test_pipeline_verdict_assignment(self, sample_match_t1):
        """Test que le verdict est assigné correctement"""
        result = process_prediction(sample_match_t1)
        
        verdict = result['verdict']
        confidence = result['confidence']
        
        # Verdict doit correspondre à la confiance
        if confidence >= 75:
            assert verdict in ['SAFE BET', 'STRONG BET']
        elif confidence < 50:
            assert verdict in ['SKIP', 'NO PREDICTION']


class TestPredictionPipelineIntegrationWithExternalData:
    """Tests d'intégration avec données externes"""
    
    @patch('requests.get')
    def test_pipeline_with_api_data(self, mock_get, sample_match_t1):
        """Test pipeline avec données API simulées"""
        # Mock API response
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            'home_form': 2.5,
            'away_form': 2.0
        }
        mock_get.return_value = mock_response
        
        result = process_prediction(sample_match_t1)
        
        assert result is not None
        assert 'verdict' in result
    
    def test_pipeline_league_tier_detection(self):
        """Test que le tier de ligue est détecté correctement"""
        # T1 league
        match_t1 = {
            'id': 1,
            'homeTeam': 'Liverpool',
            'awayTeam': 'Chelsea',
            'league': 'Premier League',
            'country': 'England',
            'startTimestamp': 1735689600
        }
        
        result = process_prediction(match_t1)
        assert result is not None
        
        # T3 league
        match_t3 = {
            'id': 2,
            'homeTeam': 'Team X',
            'awayTeam': 'Team Y',
            'league': 'Unknown League',
            'country': 'Unknown',
            'startTimestamp': 1735689600
        }
        
        result = process_prediction(match_t3)
        assert result is not None


if __name__ == '__main__':
    pytest.main([__file__, '-v', '--tb=short'])
