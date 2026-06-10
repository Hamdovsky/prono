"""Live Goal Prediction Engine — XGBoost model for in-play goal probability."""

import json
import os
import sys
import numpy as np

MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models')

FEATURE_NAMES = [
    'minute', 'score_diff', 'total_goals',
    'xg_h_remaining', 'xg_a_remaining',
    'xg_h_consumed', 'xg_a_consumed',
    'sot_h_sofar', 'sot_a_sofar',
    'possession_h', 'possession_diff',
    'half', 'minutes_remaining',
]

class LiveGoalModel:
    def __init__(self):
        self.models = {
            'next5': None,
            'next10': None,
            'next15': None,
        }
        self.meta = None
        self.loaded = False

    def load(self):
        import xgboost as xgb

        paths = {
            'next5': os.path.join(MODEL_DIR, 'live_goal_xgb.json'),
            'next10': os.path.join(MODEL_DIR, 'live_goal_xgb_next10.json'),
            'next15': os.path.join(MODEL_DIR, 'live_goal_xgb_next15.json'),
        }

        meta_path = os.path.join(MODEL_DIR, 'live_goal_xgb_meta.json')

        for key, path in paths.items():
            if os.path.exists(path):
                try:
                    model = xgb.Booster()
                    model.load_model(path)
                    self.models[key] = model
                except Exception as e:
                    print(f"[LIVE] Failed to load {key} model: {e}")

        if os.path.exists(meta_path):
            try:
                with open(meta_path) as f:
                    self.meta = json.load(f)
            except Exception:
                pass

        loaded_count = sum(1 for m in self.models.values() if m is not None)
        self.loaded = loaded_count > 0
        print(f"[LIVE] Loaded {loaded_count}/3 live goal models")
        return self.loaded

    def predict(self, features):
        """
        features: dict with keys matching FEATURE_NAMES
        
        Returns dict with next5min, next10min, next15min probabilities.
        """
        result = {'next5min': 0.5, 'next10min': 0.6, 'next15min': 0.7}

        # Build feature vector in correct order
        x = np.array([[features.get(name, 0) for name in FEATURE_NAMES]], dtype=np.float32)

        for key, model in self.models.items():
            if model is not None:
                try:
                    dmat = xgb.DMatrix(x, feature_names=FEATURE_NAMES)
                    proba = model.predict(dmat)[0]
                    if key == 'next5':
                        result['next5min'] = float(proba)
                    elif key == 'next10':
                        result['next10min'] = float(proba)
                    elif key == 'next15':
                        result['next15min'] = float(proba)
                except Exception as e:
                    print(f"[LIVE] {key} prediction error: {e}")

        return result

# Singleton
_live_model = LiveGoalModel()

def get_live_model():
    if not _live_model.loaded:
        _live_model.load()
    return _live_model

def predict_live(match_data):
    """
    match_data: dict with live match state fields
    Returns goal probability dict.
    """
    model = get_live_model()
    if not model.loaded:
        return {'next5min': 0.5, 'next10min': 0.6, 'next15min': 0.7, 'model_loaded': False}

    minute = int(match_data.get('minute', 0) or 0)
    score_h = int(match_data.get('scoreHome', 0) or 0)
    score_a = int(match_data.get('scoreAway', 0) or 0)
    home_xg = float(match_data.get('home_xg', 0) or 0)
    away_xg = float(match_data.get('away_xg', 0) or 0)
    home_sot = int(match_data.get('home_shots_on_target', 0) or 0)
    away_sot = int(match_data.get('away_shots_on_target', 0) or 0)
    home_poss = float(match_data.get('possession_home', 50) or 50)

    consumed = minute / 95.0
    features = {
        'minute': minute,
        'score_diff': score_h - score_a,
        'total_goals': score_h + score_a,
        'xg_h_remaining': max(0, home_xg - home_xg * consumed),
        'xg_a_remaining': max(0, away_xg - away_xg * consumed),
        'xg_h_consumed': home_xg * consumed,
        'xg_a_consumed': away_xg * consumed,
        'sot_h_sofar': int(home_sot * consumed),
        'sot_a_sofar': int(away_sot * consumed),
        'possession_h': home_poss,
        'possession_diff': home_poss - (100 - home_poss),
        'half': 0 if minute <= 45 else 1,
        'minutes_remaining': 95 - minute,
    }

    probs = model.predict(features)
    probs['model_loaded'] = True
    return probs
