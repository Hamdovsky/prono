"""
Integration wrapper for model_manager.py
Allows progressive migration from old to new system
"""
import os
import sys

# Feature flag: set to 'true' to use new model_manager
# Default: true (enabled for production RAM optimization)
USE_MODEL_MANAGER = os.getenv('USE_MODEL_MANAGER', 'true').lower() == 'true'

if USE_MODEL_MANAGER:
    # New system
    from model_manager import get_model_manager
    
    def get_titanium_booster():
        """Wrapper for backward compatibility"""
        return get_model_manager().get_model('titanium_v2')
    
    def get_titanium_v4_booster():
        """Wrapper for backward compatibility"""
        return get_model_manager().get_model('titanium_v4')
    
    def get_v55_booster():
        """Wrapper for backward compatibility"""
        return get_model_manager().get_model('v55')
    
    def get_v551_booster():
        """Wrapper for backward compatibility"""
        return get_model_manager().get_model('v551')
    
    def get_v552_booster():
        """Wrapper for backward compatibility"""
        return get_model_manager().get_model('v552')
    
    def get_v553_booster():
        """Wrapper for backward compatibility"""
        return get_model_manager().get_model('v553')
    
    def get_v553_premium_booster():
        """Wrapper for backward compatibility"""
        return get_model_manager().get_model('v553_premium')
    
    def get_xgb_booster():
        """Wrapper for backward compatibility (v24)"""
        return get_model_manager().get_model('v24')
    
    def get_corners_model():
        """Wrapper for backward compatibility"""
        return get_model_manager().get_model('corners')
    
    def get_cards_model():
        """Wrapper for backward compatibility"""
        return get_model_manager().get_model('cards')
    
    def get_required_models_for_prediction(league_tier, is_wc2026=False):
        """
        Get only models needed for this specific prediction.
        This is the preferred way when using model_manager.
        """
        return get_model_manager().get_required_models(league_tier, is_wc2026)
    
    def get_cache_stats():
        """Get model cache statistics for monitoring"""
        return get_model_manager().get_cache_stats()
    
    sys.stderr.write("✅ [MODEL MANAGER] Using optimized model loading\n")

else:
    # Old system - import from prediction_engine
    # This maintains backward compatibility
    sys.stderr.write("⚠️ [MODEL MANAGER] Using legacy model loading (set USE_MODEL_MANAGER=true to optimize)\n")
    
    # Import old functions
    try:
        from prediction_engine import (
            get_titanium_booster,
            get_titanium_v4_booster,
            get_v55_booster,
            get_v551_booster,
            get_v552_booster,
            get_v553_booster,
            get_v553_premium_booster
        )
    except ImportError:
        # If prediction_engine not available, provide fallback
        def get_titanium_booster():
            sys.stderr.write("⚠️ get_titanium_booster() not available\n")
            return None
        
        def get_titanium_v4_booster():
            sys.stderr.write("⚠️ get_titanium_v4_booster() not available\n")
            return None
        
        def get_v55_booster():
            sys.stderr.write("⚠️ get_v55_booster() not available\n")
            return None
        
        def get_v551_booster():
            sys.stderr.write("⚠️ get_v551_booster() not available\n")
            return None
        
        def get_v552_booster():
            sys.stderr.write("⚠️ get_v552_booster() not available\n")
            return None
        
        def get_v553_booster():
            sys.stderr.write("⚠️ get_v553_booster() not available\n")
            return None
        
        def get_v553_premium_booster():
            sys.stderr.write("⚠️ get_v553_premium_booster() not available\n")
            return None


# Export unified interface
__all__ = [
    'get_titanium_booster',
    'get_titanium_v4_booster',
    'get_v55_booster',
    'get_v551_booster',
    'get_v552_booster',
    'get_v553_booster',
    'get_v553_premium_booster',
    'USE_MODEL_MANAGER'
]

if USE_MODEL_MANAGER:
    __all__.extend([
        'get_required_models_for_prediction',
        'get_cache_stats'
    ])
