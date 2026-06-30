"""
Tests unitaires pour model_manager.py
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

import pytest
from unittest.mock import Mock, patch, MagicMock
from core.model_manager import ModelManager, get_model_manager, get_model, get_required_models


class TestModelManager:
    """Test suite for ModelManager class"""
    
    def test_singleton_pattern(self):
        """ModelManager should be a singleton"""
        manager1 = ModelManager()
        manager2 = ModelManager()
        assert manager1 is manager2
    
    def test_get_model_manager_returns_singleton(self):
        """get_model_manager() should return the same instance"""
        manager1 = get_model_manager()
        manager2 = get_model_manager()
        assert manager1 is manager2
    
    @patch('core.model_manager.get_xgb')
    def test_get_model_xgboost_not_available(self, mock_xgb):
        """Should return None if XGBoost not available"""
        mock_xgb.return_value = None
        manager = ModelManager()
        manager._models = {}  # Clear cache
        
        result = manager.get_model('v55')
        assert result is None
    
    @patch('core.model_manager.get_xgb')
    @patch('os.path.exists')
    def test_get_model_file_not_found(self, mock_exists, mock_xgb):
        """Should return None if model file doesn't exist"""
        mock_xgb.return_value = MagicMock()
        mock_exists.return_value = False
        
        manager = ModelManager()
        manager._models = {}  # Clear cache
        
        result = manager.get_model('v55')
        assert result is None
    
    @patch('core.model_manager.get_xgb')
    @patch('os.path.exists')
    def test_get_model_loads_successfully(self, mock_exists, mock_xgb):
        """Should load model successfully and cache it"""
        mock_booster = MagicMock()
        mock_xgb_module = MagicMock()
        mock_xgb_module.Booster.return_value = mock_booster
        mock_xgb.return_value = mock_xgb_module
        mock_exists.return_value = True
        
        manager = ModelManager()
        manager._models = {}  # Clear cache
        
        result = manager.get_model('v55')
        
        assert result == mock_booster
        assert 'v55' in manager._models
        assert manager._models['v55'] == mock_booster
    
    @patch('core.model_manager.get_xgb')
    def test_get_model_returns_cached(self, mock_xgb):
        """Should return cached model without reloading"""
        mock_booster = MagicMock()
        
        manager = ModelManager()
        manager._models = {'v55': mock_booster}
        
        result = manager.get_model('v55')
        
        assert result == mock_booster
        # Booster() should not be called since we're using cache
        mock_xgb.return_value.Booster.assert_not_called()
    
    def test_get_model_unknown_name(self):
        """Should return None for unknown model name"""
        manager = ModelManager()
        result = manager.get_model('unknown_model')
        assert result is None
    
    @patch.object(ModelManager, 'get_model')
    def test_get_required_models_t1(self, mock_get_model):
        """Should load v55 and v24 for T1 leagues"""
        mock_v55 = MagicMock()
        mock_v24 = MagicMock()
        
        def side_effect(name):
            if name == 'v55':
                return mock_v55
            elif name == 'v24':
                return mock_v24
            return None
        
        mock_get_model.side_effect = side_effect
        
        manager = ModelManager()
        models = manager.get_required_models('T1', is_wc2026=False)
        
        assert 'v55' in models
        assert 'v24' in models
        assert models['v55'] == mock_v55
        assert models['v24'] == mock_v24
    
    @patch.object(ModelManager, 'get_model')
    def test_get_required_models_t3(self, mock_get_model):
        """Should load only v55 for T3 leagues"""
        mock_v55 = MagicMock()
        mock_get_model.return_value = mock_v55
        
        manager = ModelManager()
        models = manager.get_required_models('T3', is_wc2026=False)
        
        assert 'v55' in models
        assert 'v24' not in models
        mock_get_model.assert_called_once_with('v55')
    
    @patch.object(ModelManager, 'get_model')
    def test_get_required_models_wc2026(self, mock_get_model):
        """Should load v553_premium for WC2026 matches"""
        mock_model = MagicMock()
        mock_get_model.return_value = mock_model
        
        manager = ModelManager()
        models = manager.get_required_models('T1', is_wc2026=True)
        
        # Should be called for v55, v24, and v553_premium
        assert mock_get_model.call_count >= 3
        call_args = [call[0][0] for call in mock_get_model.call_args_list]
        assert 'v553_premium' in call_args
    
    def test_unload_model(self):
        """Should unload model from cache"""
        mock_model = MagicMock()
        manager = ModelManager()
        manager._models = {'v55': mock_model}
        
        manager.unload_model('v55')
        
        assert 'v55' not in manager._models
    
    def test_unload_model_not_loaded(self):
        """Should handle unloading non-existent model gracefully"""
        manager = ModelManager()
        manager._models = {}
        
        # Should not raise exception
        manager.unload_model('v55')
    
    def test_clear_cache(self):
        """Should clear all models from cache"""
        manager = ModelManager()
        manager._models = {
            'v55': MagicMock(),
            'v24': MagicMock(),
            'titanium_v2': MagicMock()
        }
        
        manager.clear_cache()
        
        assert len(manager._models) == 0
    
    def test_get_cache_stats(self):
        """Should return cache statistics"""
        mock_v55 = MagicMock()
        mock_v24 = MagicMock()
        
        manager = ModelManager()
        manager._models = {'v55': mock_v55, 'v24': mock_v24}
        
        stats = manager.get_cache_stats()
        
        assert stats['count'] == 2
        assert 'v55' in stats['loaded_models']
        assert 'v24' in stats['loaded_models']
        assert 'available_models' in stats
        assert isinstance(stats['available_models'], list)


class TestBackwardCompatibility:
    """Test backward compatibility functions"""
    
    @patch.object(ModelManager, 'get_model')
    def test_get_model_function(self, mock_method):
        """get_model() function should delegate to ModelManager"""
        mock_model = MagicMock()
        mock_method.return_value = mock_model
        
        result = get_model('v55')
        
        assert result == mock_model
        mock_method.assert_called_once_with('v55')
    
    @patch.object(ModelManager, 'get_required_models')
    def test_get_required_models_function(self, mock_method):
        """get_required_models() function should delegate to ModelManager"""
        mock_models = {'v55': MagicMock()}
        mock_method.return_value = mock_models
        
        result = get_required_models('T1', is_wc2026=False)
        
        assert result == mock_models
        mock_method.assert_called_once_with('T1', is_wc2026=False)


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
