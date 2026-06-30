"""
Optimized XGBoost Model Manager
Lazy loads only required models to reduce RAM footprint
"""
import os
import sys
from typing import Optional, Dict

# Lazy XGBoost import
_xgb = None

def get_xgb():
    """Lazy import XGBoost to avoid import errors if not installed"""
    global _xgb
    if _xgb is None:
        try:
            import xgboost as xgb
            _xgb = xgb
        except Exception as e:
            sys.stderr.write(f"❌ XGBOOST NON DISPONIBLE: {e}\n")
            _xgb = None
    return _xgb


class ModelManager:
    """
    Singleton manager for XGBoost models with lazy loading.
    Only loads models when needed to minimize RAM usage.
    """
    
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
            
        self._initialized = True
        self._models = {}
        self._model_paths = {
            'v24': 'models/stitch_v24_hybrid.json',
            'v55': 'models/stitch_v55_optimized.json',
            'v551': 'models/stitch_v551_optimized.json',
            'v552': 'models/stitch_v552_optimized.json',
            'v553': 'models/stitch_v553_optimized.json',
            'v553_premium': 'models/stitch_v553_premium.json',
            'titanium_v2': 'models/titanium_v2.json',
            'titanium_v4': 'models/titanium_v4.json',
            'corners': 'models/stitch_corners_v1.json',
            'cards': 'models/stitch_cards_v1.json',
            'live_goal': 'models/live_goal_xgb.json',
            'live_next10': 'models/live_goal_xgb_next10.json',
            'live_next15': 'models/live_goal_xgb_next15.json',
        }
    
    def get_model(self, model_name: str):
        """
        Get a model by name. Loads it if not already cached.
        
        Args:
            model_name: One of the keys in _model_paths
            
        Returns:
            XGBoost Booster object or None if loading fails
        """
        xgb = get_xgb()
        if xgb is None:
            return None
        
        # Return cached model if already loaded
        if model_name in self._models:
            return self._models[model_name]
        
        # Load model
        model_path = self._model_paths.get(model_name)
        if not model_path:
            sys.stderr.write(f"⚠️ Unknown model name: {model_name}\n")
            return None
        
        try:
            full_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), model_path)
            if not os.path.exists(full_path):
                sys.stderr.write(f"⚠️ Model file not found: {full_path}\n")
                return None
            
            booster = xgb.Booster()
            booster.load_model(full_path)
            self._models[model_name] = booster
            
            # Log loaded models count for monitoring
            loaded_count = len(self._models)
            sys.stderr.write(f"✅ Loaded model '{model_name}' ({loaded_count} models in cache)\n")
            
            return booster
            
        except Exception as e:
            sys.stderr.write(f"❌ Failed to load model '{model_name}': {e}\n")
            return None
    
    def get_required_models(self, league_tier: str, is_wc2026: bool = False) -> Dict[str, any]:
        """
        Load only the models required for a specific prediction.
        
        Args:
            league_tier: T1/T2/T3/BLACKLIST
            is_wc2026: Whether this is a World Cup 2026 match
            
        Returns:
            Dictionary of loaded models
        """
        required = []
        
        # Base ensemble models
        if league_tier in ['T1', 'T2']:
            required.extend(['v55', 'v24'])
        elif league_tier == 'T3':
            required.append('v55')  # Only V55 for T3
        
        # Special models
        if is_wc2026:
            required.append('v553_premium')
        
        # Load all required models
        models = {}
        for model_name in required:
            model = self.get_model(model_name)
            if model:
                models[model_name] = model
        
        return models
    
    def unload_model(self, model_name: str):
        """
        Unload a model from cache to free RAM.
        Useful for long-running processes.
        """
        if model_name in self._models:
            del self._models[model_name]
            sys.stderr.write(f"🗑️  Unloaded model '{model_name}'\n")
    
    def clear_cache(self):
        """Clear all loaded models from cache"""
        count = len(self._models)
        self._models.clear()
        sys.stderr.write(f"🗑️  Cleared {count} models from cache\n")
    
    def get_cache_stats(self) -> Dict[str, any]:
        """Get statistics about loaded models"""
        return {
            'loaded_models': list(self._models.keys()),
            'count': len(self._models),
            'available_models': list(self._model_paths.keys())
        }


# Singleton instance
_model_manager = ModelManager()

def get_model_manager() -> ModelManager:
    """Get the singleton ModelManager instance"""
    return _model_manager


# Backward compatibility functions
def get_model(model_name: str):
    """Get a model by name (backward compatible)"""
    return _model_manager.get_model(model_name)


def get_required_models(league_tier: str, is_wc2026: bool = False):
    """Get only required models for prediction (backward compatible)"""
    return _model_manager.get_required_models(league_tier, is_wc2026)


if __name__ == '__main__':
    # Test model manager
    manager = get_model_manager()
    
    print("Testing ModelManager...")
    
    # Test loading a single model
    model = manager.get_model('v55')
    if model:
        print("[OK] Successfully loaded v55 model")
    
    # Test cache stats
    stats = manager.get_cache_stats()
    print(f"Cache stats: {stats}")
    
    # Test required models
    required = manager.get_required_models('T1', is_wc2026=False)
    print(f"Required models for T1: {list(required.keys())}")
    
    # Test cache clear
    manager.clear_cache()
    stats = manager.get_cache_stats()
    print(f"After clear: {stats}")
