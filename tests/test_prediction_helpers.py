"""
Tests unitaires pour les fonctions helpers de prediction_engine.py
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

import pytest
from core.prediction_engine import (
    _safe_float,
    _f_feat,
    calculate_ah_dnb_probs
)


class TestSafeFloat:
    """Tests pour la fonction _safe_float()"""
    
    def test_safe_float_valid_number(self):
        """Should convert valid number to float"""
        assert _safe_float(5) == 5.0
        assert _safe_float(5.5) == 5.5
        assert _safe_float("5.5") == 5.5
    
    def test_safe_float_none(self):
        """Should return default for None"""
        assert _safe_float(None) == 0.0
        assert _safe_float(None, 10.0) == 10.0
    
    def test_safe_float_nan(self):
        """Should return default for NaN strings"""
        assert _safe_float("nan") == 0.0
        assert _safe_float("NaN") == 0.0
        assert _safe_float("null") == 0.0
        assert _safe_float("none") == 0.0
        assert _safe_float("") == 0.0
    
    def test_safe_float_invalid(self):
        """Should return default for invalid input"""
        assert _safe_float("invalid") == 0.0
        assert _safe_float("abc", 5.0) == 5.0
        assert _safe_float([], 10.0) == 10.0


class TestFFeat:
    """Tests pour la fonction _f_feat()"""
    
    def test_f_feat_from_dict(self):
        """Should extract value from dictionary"""
        source = {"home_xg": 2.5, "away_xg": 1.3}
        assert _f_feat("home_xg", source) == 2.5
        assert _f_feat("away_xg", source) == 1.3
    
    def test_f_feat_missing_key(self):
        """Should return default for missing key"""
        source = {"home_xg": 2.5}
        assert _f_feat("away_xg", source) == 0.0
        assert _f_feat("away_xg", source, 1.0) == 1.0
    
    def test_f_feat_from_object(self):
        """Should extract value from object attribute"""
        class MockObj:
            home_xg = 2.5
            away_xg = 1.3
        
        source = MockObj()
        assert _f_feat("home_xg", source) == 2.5
        assert _f_feat("away_xg", source) == 1.3
    
    def test_f_feat_none_source(self):
        """Should return default for None source"""
        assert _f_feat("any_key", None) == 0.0
        assert _f_feat("any_key", None, 10.0) == 10.0
    
    def test_f_feat_invalid_value(self):
        """Should handle invalid values gracefully"""
        source = {"home_xg": "invalid"}
        assert _f_feat("home_xg", source) == 0.0


class TestCalculateAhDnbProbs:
    """Tests pour calculate_ah_dnb_probs()"""
    
    def test_calculate_ah_dnb_normal(self):
        """Should calculate DNB and DC probabilities correctly"""
        p_h = 0.5
        p_d = 0.3
        p_a = 0.2
        
        dnb_h, dnb_a, dc_h, dc_a, dc_12 = calculate_ah_dnb_probs(p_h, p_d, p_a)
        
        # DNB (Draw No Bet) - redistribute draw probability
        assert abs(dnb_h - (0.5 / 0.7)) < 0.001  # ~0.714
        assert abs(dnb_a - (0.2 / 0.7)) < 0.001  # ~0.286
        
        # Double Chance
        assert dc_h == 0.8  # Home or Draw
        assert dc_a == 0.5  # Away or Draw
        assert dc_12 == 0.7  # Home or Away
    
    def test_calculate_ah_dnb_zero_non_draw(self):
        """Should handle edge case where p_h + p_a = 0"""
        p_h = 0.0
        p_d = 1.0
        p_a = 0.0
        
        dnb_h, dnb_a, dc_h, dc_a, dc_12 = calculate_ah_dnb_probs(p_h, p_d, p_a)
        
        # Should return default values
        assert dnb_h == 0.5
        assert dnb_a == 0.5
        assert dc_h == 1.0
        assert dc_a == 1.0
        assert dc_12 == 0.0
    
    def test_calculate_ah_dnb_strong_favorite(self):
        """Should handle strong favorite scenario"""
        p_h = 0.7
        p_d = 0.2
        p_a = 0.1
        
        dnb_h, dnb_a, dc_h, dc_a, dc_12 = calculate_ah_dnb_probs(p_h, p_d, p_a)
        
        assert dnb_h > 0.8  # Strong home favorite
        assert dnb_a < 0.2  # Weak away
        assert dc_h == 0.9  # Very high home or draw
        assert dc_a == 0.3  # Low away or draw
    
    def test_calculate_ah_dnb_balanced(self):
        """Should handle balanced match"""
        p_h = 0.33
        p_d = 0.34
        p_a = 0.33
        
        dnb_h, dnb_a, dc_h, dc_a, dc_12 = calculate_ah_dnb_probs(p_h, p_d, p_a)
        
        # DNB should be close to 50/50
        assert abs(dnb_h - 0.5) < 0.05
        assert abs(dnb_a - 0.5) < 0.05
        
        # DC should be close to 0.67
        assert abs(dc_h - 0.67) < 0.02
        assert abs(dc_a - 0.67) < 0.02


class TestPredictionEngineHelpers:
    """Tests d'intégration pour helpers"""
    
    def test_safe_float_chain(self):
        """Should handle chained safe float operations"""
        data = {
            "home_xg": "2.5",
            "away_xg": None,
            "confidence": "invalid"
        }
        
        home_xg = _safe_float(data.get("home_xg"), 1.0)
        away_xg = _safe_float(data.get("away_xg"), 1.0)
        confidence = _safe_float(data.get("confidence"), 50.0)
        
        assert home_xg == 2.5
        assert away_xg == 1.0
        assert confidence == 50.0
    
    def test_probability_sum(self):
        """Probabilities from ah_dnb should sum correctly"""
        p_h = 0.4
        p_d = 0.3
        p_a = 0.3
        
        dnb_h, dnb_a, dc_h, dc_a, dc_12 = calculate_ah_dnb_probs(p_h, p_d, p_a)
        
        # DNB probabilities should sum to 1
        assert abs((dnb_h + dnb_a) - 1.0) < 0.001
        
        # DC probabilities should overlap correctly
        assert abs((dc_h + dc_a + dc_12) - (p_h + p_d + p_a + p_h + p_a)) < 0.001


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
