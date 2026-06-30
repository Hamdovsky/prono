"""
Tests unitaires pour goal_model.py
Coverage: distributions Poisson, Dixon-Coles, Monte Carlo, marchés BTTS/O-U
"""
import pytest
import numpy as np
from unittest.mock import patch, MagicMock
import sys
import os

# Add core/ to path
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
    """Tests pour la fonction de densité de Poisson"""
    
    def test_poisson_zero_goals(self):
        """Test P(X=0) avec lambda=1.5"""
        prob = poisson_pmf(0, 1.5)
        expected = np.exp(-1.5)
        assert abs(prob - expected) < 0.0001
    
    def test_poisson_one_goal(self):
        """Test P(X=1) avec lambda=2.0"""
        prob = poisson_pmf(1, 2.0)
        expected = 2.0 * np.exp(-2.0)
        assert abs(prob - expected) < 0.0001
    
    def test_poisson_high_goals(self):
        """Test P(X=5) avec lambda=1.2"""
        prob = poisson_pmf(5, 1.2)
        # Expected: (1.2^5 / 5!) * e^(-1.2)
        assert 0 < prob < 0.1
        assert isinstance(prob, float)
    
    def test_poisson_zero_lambda(self):
        """Test avec lambda=0 (edge case)"""
        prob = poisson_pmf(0, 0.0)
        assert prob == 1.0  # P(X=0 | lambda=0) = 1
        
        prob = poisson_pmf(1, 0.0)
        assert prob == 0.0  # P(X>0 | lambda=0) = 0
    
    def test_poisson_high_lambda(self):
        """Test avec lambda très élevé"""
        prob = poisson_pmf(3, 5.0)
        assert 0 < prob < 1
        assert isinstance(prob, float)


class TestDixonColesAdjustment:
    """Tests pour l'ajustement Dixon-Coles"""
    
    def test_adjustment_0_0(self):
        """Test ajustement pour 0-0"""
        adj = get_dixon_coles_adjustment(1.5, 1.2, 0, 0, rho=-0.12)
        assert adj != 1.0  # Doit être différent de 1 pour 0-0
        assert adj > 0
    
    def test_adjustment_1_0(self):
        """Test ajustement pour 1-0"""
        adj = get_dixon_coles_adjustment(1.5, 1.2, 1, 0, rho=-0.12)
        assert adj != 1.0
        assert adj > 0
    
    def test_adjustment_0_1(self):
        """Test ajustement pour 0-1"""
        adj = get_dixon_coles_adjustment(1.5, 1.2, 0, 1, rho=-0.12)
        assert adj != 1.0
        assert adj > 0
    
    def test_adjustment_1_1(self):
        """Test ajustement pour 1-1"""
        adj = get_dixon_coles_adjustment(1.5, 1.2, 1, 1, rho=-0.12)
        assert adj != 1.0
        assert adj > 0
    
    def test_adjustment_high_score(self):
        """Test ajustement pour score élevé (pas d'effet Dixon-Coles)"""
        adj = get_dixon_coles_adjustment(1.5, 1.2, 3, 2, rho=-0.12)
        assert adj == 1.0  # Pas d'ajustement pour scores > 1
    
    def test_adjustment_rho_zero(self):
        """Test avec rho=0 (pas de corrélation)"""
        adj = get_dixon_coles_adjustment(1.5, 1.2, 0, 0, rho=0.0)
        assert adj == 1.0  # Pas d'ajustement si rho=0


class TestMonteCarloSimulation:
    """Tests pour la simulation Monte Carlo"""
    
    def test_simulation_basic(self):
        """Test simulation standard"""
        result = monte_carlo_simulation_goalmodel(2.0, 1.5, n_simulations=1000)
        
        assert 'probabilities' in result
        assert 'home' in result['probabilities']
        assert 'draw' in result['probabilities']
        assert 'away' in result['probabilities']
        
        # Somme des probas doit être ~1.0
        total_prob = sum(result['probabilities'].values())
        assert abs(total_prob - 1.0) < 0.01
    
    def test_simulation_home_favorite(self):
        """Test avec home très favori"""
        result = monte_carlo_simulation_goalmodel(3.0, 0.8, n_simulations=1000)
        
        probs = result['probabilities']
        assert probs['home'] > probs['draw']
        assert probs['home'] > probs['away']
    
    def test_simulation_away_favorite(self):
        """Test avec away très favori"""
        result = monte_carlo_simulation_goalmodel(0.8, 3.0, n_simulations=1000)
        
        probs = result['probabilities']
        assert probs['away'] > probs['draw']
        assert probs['away'] > probs['home']
    
    def test_simulation_balanced(self):
        """Test avec match équilibré"""
        result = monte_carlo_simulation_goalmodel(1.5, 1.5, n_simulations=1000)
        
        probs = result['probabilities']
        # Home et away doivent être proches
        assert abs(probs['home'] - probs['away']) < 0.1
    
    def test_simulation_score_distribution(self):
        """Test distribution des scores"""
        result = monte_carlo_simulation_goalmodel(2.0, 1.5, n_simulations=1000)
        
        # Doit contenir expected_score
        assert 'expected_score' in result
        assert len(result['expected_score']) == 2
        assert all(isinstance(x, (int, float)) for x in result['expected_score'])
    
    def test_simulation_zero_xg(self):
        """Test avec xG=0 (edge case)"""
        result = monte_carlo_simulation_goalmodel(0.0, 0.0, n_simulations=500)
        
        # Doit prévoir draw avec 0-0
        probs = result['probabilities']
        assert probs['draw'] > 0.9  # Très probable que ce soit 0-0


class TestBTTSPrediction:
    """Tests pour Both Teams To Score"""
    
    def test_btts_high_xg(self):
        """Test BTTS avec xG élevés"""
        prob = predict_btts(2.5, 2.0)
        assert prob > 0.7  # Forte probabilité
        assert 0 <= prob <= 1
    
    def test_btts_low_xg(self):
        """Test BTTS avec xG faibles"""
        prob = predict_btts(0.5, 0.5)
        assert prob < 0.3  # Faible probabilité
        assert 0 <= prob <= 1
    
    def test_btts_one_high_one_low(self):
        """Test BTTS avec un xG élevé et un faible"""
        prob = predict_btts(3.0, 0.5)
        assert 0.2 < prob < 0.6  # Probabilité moyenne
    
    def test_btts_zero_xg(self):
        """Test BTTS avec xG=0"""
        prob = predict_btts(0.0, 0.0)
        assert prob < 0.1  # Très faible probabilité


class TestOverUnderPrediction:
    """Tests pour Over/Under"""
    
    def test_ou_2_5_high_xg(self):
        """Test O/U 2.5 avec xG élevés"""
        result = predict_ou(2.5, 2.0, threshold=2.5)
        
        assert 'over' in result
        assert 'under' in result
        assert result['over'] > 0.5  # Over plus probable
        assert abs(result['over'] + result['under'] - 1.0) < 0.01
    
    def test_ou_2_5_low_xg(self):
        """Test O/U 2.5 avec xG faibles"""
        result = predict_ou(0.8, 0.8, threshold=2.5)
        
        assert result['under'] > 0.7  # Under très probable
    
    def test_ou_1_5(self):
        """Test O/U 1.5"""
        result = predict_ou(1.5, 1.5, threshold=1.5)
        
        # Doit être équilibré
        assert 0.4 < result['over'] < 0.6
    
    def test_ou_3_5(self):
        """Test O/U 3.5"""
        result = predict_ou(2.0, 2.0, threshold=3.5)
        
        # Over 3.5 avec xG=2+2=4 -> probable
        assert result['over'] > 0.4


class TestMostLikelyScore:
    """Tests pour le score le plus probable"""
    
    def test_most_likely_balanced(self):
        """Test score probable pour match équilibré"""
        result = calculate_most_likely_score_goalmodel(1.5, 1.5)
        
        assert 'home_score' in result
        assert 'away_score' in result
        assert 'probability' in result
        
        # Scores doivent être proches
        assert abs(result['home_score'] - result['away_score']) <= 1
    
    def test_most_likely_home_favorite(self):
        """Test score probable pour home favori"""
        result = calculate_most_likely_score_goalmodel(2.5, 1.0)
        
        assert result['home_score'] >= result['away_score']
    
    def test_most_likely_away_favorite(self):
        """Test score probable pour away favori"""
        result = calculate_most_likely_score_goalmodel(1.0, 2.5)
        
        assert result['away_score'] >= result['home_score']
    
    def test_most_likely_probability_range(self):
        """Test que la probabilité est valide"""
        result = calculate_most_likely_score_goalmodel(2.0, 1.5)
        
        assert 0 < result['probability'] < 1
        # Le score le plus probable ne doit pas dépasser 30%
        assert result['probability'] < 0.3
    
    def test_most_likely_low_xg(self):
        """Test avec xG faibles"""
        result = calculate_most_likely_score_goalmodel(0.5, 0.5)
        
        # Doit prédire 0-0 ou 1-0 ou 0-1
        assert result['home_score'] <= 1
        assert result['away_score'] <= 1


class TestEdgeCases:
    """Tests pour les cas limites"""
    
    def test_negative_xg(self):
        """Test avec xG négatifs (ne devrait pas arriver)"""
        # Les fonctions doivent gérer gracieusement
        result = monte_carlo_simulation_goalmodel(-1.0, 1.5, n_simulations=100)
        assert result is not None
    
    def test_very_high_xg(self):
        """Test avec xG très élevés"""
        result = monte_carlo_simulation_goalmodel(5.0, 5.0, n_simulations=500)
        
        probs = result['probabilities']
        assert abs(sum(probs.values()) - 1.0) < 0.01
    
    def test_small_simulation_count(self):
        """Test avec peu de simulations"""
        result = monte_carlo_simulation_goalmodel(2.0, 1.5, n_simulations=10)
        
        # Doit quand même retourner des résultats
        assert 'probabilities' in result
    
    def test_large_simulation_count(self):
        """Test avec beaucoup de simulations"""
        result = monte_carlo_simulation_goalmodel(2.0, 1.5, n_simulations=50000)
        
        # Résultats doivent être stables
        total = sum(result['probabilities'].values())
        assert abs(total - 1.0) < 0.001


if __name__ == '__main__':
    pytest.main([__file__, '-v', '--tb=short'])
