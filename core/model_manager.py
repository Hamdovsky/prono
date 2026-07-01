"""
model_manager.py - Module 3: XGBoost model loading, Monte Carlo simulation, ensemble
Extracted from prediction_engine.py (lines 111-249, 332-483)

Responsibilities:
- Lazy-loaded XGBoost model boosters (11 models)
- Quantum Monte Carlo simulation with Gaussian noise injection
- League-specific draw bias correction
- Crisis mode auto-boost
- Referee bias adjustment
"""

import os
import sys
import math
import numpy as np

from data_loader import safe_float, get_league_draw_multiplier

# Lazy-loaded xgboost module
_xgb = None


# ============================================================================
# XGBOOST MODULE LOADING
# ============================================================================

def get_xgb():
    """Lazy-load xgboost module to avoid import failures."""
    global _xgb
    if _xgb is None:
        try:
            import xgboost as xgb
            _xgb = xgb
        except Exception as e:
            sys.stderr.write(f"XGBOOST NOT AVAILABLE: {e}\n")
            sys.stderr.write("ML predictions disabled until xgboost is installed.\n")
            _xgb = None
    return _xgb


# ============================================================================
# MODEL PATHS
# ============================================================================

CORE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(CORE_DIR)

XGB_MODEL_PATH = os.path.join(PROJECT_DIR, 'models', 'stitch_v24_hybrid.json')
V55_MODEL_PATH = os.path.join(PROJECT_DIR, 'models', 'stitch_v55_optimized.json')
V551_MODEL_PATH = os.path.join(PROJECT_DIR, 'models', 'stitch_v551_optimized.json')
V552_MODEL_PATH = os.path.join(PROJECT_DIR, 'models', 'stitch_v552_optimized.json')
V553_MODEL_PATH = os.path.join(PROJECT_DIR, 'models', 'stitch_v553_optimized.json')
V553_PREMIUM_MODEL_PATH = os.path.join(PROJECT_DIR, 'models', 'stitch_v553_premium.json')
CORNERS_MODEL_PATH = os.path.join(PROJECT_DIR, 'models', 'stitch_corners_v1.json')
CARDS_MODEL_PATH = os.path.join(PROJECT_DIR, 'models', 'stitch_cards_v1.json')
TITANIUM_MODEL_PATH = os.path.join(PROJECT_DIR, 'models', 'titanium_v2.json')
TITANIUM_V4_MODEL_PATH = os.path.join(PROJECT_DIR, 'models', 'titanium_v4.json')


# ============================================================================
# LAZY-LOADED MODEL BOOSTERS
# ============================================================================

_XGB_BOOSTER = None
_XGB_V55_BOOSTER = None
_XGB_V551_BOOSTER = None
_XGB_V552_BOOSTER = None
_XGB_V553_BOOSTER = None
_XGB_V553_PREMIUM_BOOSTER = None
_CORNERS_MODEL = None
_CARDS_MODEL = None
_TITANIUM_BOOSTER = None
_TITANIUM_V4_BOOSTER = None


_BOOSTER_CACHE = {}


def _load_booster(path, name):
    """Generic lazy loader for XGBoost model files with path-level singleton cache."""
    if path in _BOOSTER_CACHE:
        return _BOOSTER_CACHE[path]
    xgb = get_xgb()
    if xgb is None:
        return None
    if not os.path.exists(path):
        return None
    try:
        model = xgb.Booster()
        model.load_model(path)
        _BOOSTER_CACHE[path] = model
        return model
    except Exception as e:
        sys.stderr.write(f"[XGB] Failed to load {name}: {str(e)}\n")
        return None


def get_titanium_booster():
    global _TITANIUM_BOOSTER
    if _TITANIUM_BOOSTER is None:
        _TITANIUM_BOOSTER = _load_booster(TITANIUM_MODEL_PATH, "Titanium")
    return _TITANIUM_BOOSTER


def get_titanium_v4_booster():
    global _TITANIUM_V4_BOOSTER
    if _TITANIUM_V4_BOOSTER is None:
        _TITANIUM_V4_BOOSTER = _load_booster(TITANIUM_V4_MODEL_PATH, "Titanium V4")
    return _TITANIUM_V4_BOOSTER


def get_v55_booster():
    global _XGB_V55_BOOSTER
    if _XGB_V55_BOOSTER is None:
        _XGB_V55_BOOSTER = _load_booster(V55_MODEL_PATH, "V55")
    return _XGB_V55_BOOSTER


def get_v551_booster():
    global _XGB_V551_BOOSTER
    if _XGB_V551_BOOSTER is None:
        _XGB_V551_BOOSTER = _load_booster(V551_MODEL_PATH, "V551")
    return _XGB_V551_BOOSTER


def get_v552_booster():
    global _XGB_V552_BOOSTER
    if _XGB_V552_BOOSTER is None:
        _XGB_V552_BOOSTER = _load_booster(V552_MODEL_PATH, "V552")
    return _XGB_V552_BOOSTER


def get_v553_booster():
    global _XGB_V553_BOOSTER
    if _XGB_V553_BOOSTER is None:
        _XGB_V553_BOOSTER = _load_booster(V553_MODEL_PATH, "V553")
    return _XGB_V553_BOOSTER


def get_v553_premium_booster():
    global _XGB_V553_PREMIUM_BOOSTER
    if _XGB_V553_PREMIUM_BOOSTER is None:
        _XGB_V553_PREMIUM_BOOSTER = _load_booster(V553_PREMIUM_MODEL_PATH, "V553 Premium")
    return _XGB_V553_PREMIUM_BOOSTER


def get_main_booster():
    global _XGB_BOOSTER
    if _XGB_BOOSTER is None:
        _XGB_BOOSTER = _load_booster(XGB_MODEL_PATH, "V24 Legacy")
    return _XGB_BOOSTER


def get_corners_model():
    global _CORNERS_MODEL
    if _CORNERS_MODEL is None:
        _CORNERS_MODEL = _load_booster(CORNERS_MODEL_PATH, "Corners")
    return _CORNERS_MODEL


def get_cards_model():
    global _CARDS_MODEL
    if _CARDS_MODEL is None:
        _CARDS_MODEL = _load_booster(CARDS_MODEL_PATH, "Cards")
    return _CARDS_MODEL


# ============================================================================
# QUANTUM MONTE CARLO SIMULATION
# ============================================================================

def simulate_match_mc(model, base_features, num_simulations=500, feature_names=None,
                      fatigue_impact=(1.0, 1.0), injury_impact=(0.0, 0.0),
                      match_seed=None, league_name=None):
    """
    Quantum Monte Carlo Simulation with tiered Gaussian noise injection.

    Injects noise into feature vectors to model performance variance and uncertainty,
    then runs XGBoost inference on each noisy vector.

    Returns: (p_home, p_draw, p_away) averaged over all simulations.
    """
    # Deterministic RNG seeding
    if match_seed is None:
        match_seed = int(abs(hash(tuple(round(float(x), 4) for x in base_features)))) % (2**31)
    rng = np.random.default_rng(seed=match_seed)

    X_base = np.array(base_features, dtype=float)
    if X_base.ndim > 1:
        X_base = X_base.flatten()

    # Apply physiological penalties to base feature vector
    if feature_names:
        for idx, fname in enumerate(feature_names):
            if fname.startswith('h_') or 'home_' in fname:
                X_base[idx] *= fatigue_impact[0]
                if injury_impact[0] > 0:
                    penalty = min(0.10, injury_impact[0] * 0.02)
                    X_base[idx] *= (1.0 - penalty)
            elif fname.startswith('a_') or 'away_' in fname:
                X_base[idx] *= fatigue_impact[1]
                if injury_impact[1] > 0:
                    penalty = min(0.10, injury_impact[1] * 0.02)
                    X_base[idx] *= (1.0 - penalty)

    # Extract weather and referee bias from features
    weather_impact = 1.0
    ref_bias = 0.45
    if feature_names:
        if 'weather_impact' in feature_names:
            weather_impact = safe_float(X_base[feature_names.index('weather_impact')])
        if 'ref_bias' in feature_names:
            ref_bias = safe_float(X_base[feature_names.index('ref_bias')])

    # Generate noise matrix [num_simulations, num_features]
    # Lazy import of FEATURE_VOLATILITY to avoid circular imports
    try:
        from ml_features import FEATURE_VOLATILITY
    except ImportError:
        FEATURE_VOLATILITY = {}

    num_features = len(X_base)
    noise_matrix = np.zeros((num_simulations, num_features))

    for i in range(num_features):
        fname = feature_names[i] if feature_names and i < len(feature_names) else "unknown"
        vol = FEATURE_VOLATILITY.get(fname, 0.05)
        vol = min(vol, 0.08)

        if weather_impact > 1.05 and vol > 0.02:
            vol *= min(1.5, weather_impact)

        if (fname.startswith('h_') or 'home_' in fname) and injury_impact[0] >= 3.0 and vol > 0.02:
            vol *= 1.25
        elif (fname.startswith('a_') or 'away_' in fname) and injury_impact[1] >= 3.0 and vol > 0.02:
            vol *= 1.25

        noise_matrix[:, i] = rng.normal(0, vol, num_simulations)

    # Apply noise to non-binary features
    X_simulated = np.tile(X_base, (num_simulations, 1))
    for i in range(num_features):
        if X_base[i] != 0 and X_base[i] != 1:
            X_simulated[:, i] *= (1.0 + noise_matrix[:, i])

    # Crisis mode: boost simulations if many key players missing
    if (injury_impact[0] > 6.0 or injury_impact[1] > 6.0) and num_simulations < 1000:
        num_simulations = 1000
        rng = np.random.default_rng(seed=match_seed + 1)

    fn = feature_names if feature_names and len(feature_names) == X_simulated.shape[1] else None
    xgb = get_xgb()
    if xgb is None:
        return None, None, None, None

    dmatrix = xgb.DMatrix(X_simulated, feature_names=fn)
    predictions = model.predict(dmatrix)

    if predictions.ndim == 2 and predictions.shape[1] >= 3:
        win_probability = float(np.mean(predictions[:, 0]))
        draw_probability = float(np.mean(predictions[:, 1]))
        loss_probability = float(np.mean(predictions[:, 2]))

        # Referee bias adjustment
        if ref_bias > 0.52:
            shift = (ref_bias - 0.50) * 0.15
            win_probability += shift
            loss_probability -= shift
        elif ref_bias < 0.40:
            shift = (0.45 - ref_bias) * 0.15
            loss_probability += shift
            win_probability -= shift

        # Draw bias correction (league-aware)
        if draw_probability < 0.26 and abs(win_probability - loss_probability) < 0.25:
            league_draw_mult = get_league_draw_multiplier(feature_names, base_features, league_name=league_name)
            draw_probability *= league_draw_mult

    else:
        win_probability = float(np.mean(predictions == 0))
        draw_probability = float(np.mean(predictions == 1))
        loss_probability = float(np.mean(predictions == 2))

        if draw_probability < 0.18:
            league_draw_mult = get_league_draw_multiplier(feature_names, base_features, league_name=league_name)
            draw_probability *= min(1.15, league_draw_mult)

    # Re-normalize
    total_p = win_probability + draw_probability + loss_probability
    if total_p > 0:
        win_probability /= total_p
        draw_probability /= total_p
        loss_probability /= total_p

    return win_probability, draw_probability, loss_probability
