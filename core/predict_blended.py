"""
predict_blended.py — Blended prediction using V553 + Promosport enriched models.

Usage:
  echo '{"homeTeam":"...","awayTeam":"...",...}' | python core/predict_blended.py
  python -c "from predict_blended import predict; print(predict({'homeTeam':'...','awayTeam':'...'}))"
"""
import os, sys, json, warnings
import numpy as np

current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

warnings.filterwarnings('ignore')

BASE_DIR = os.path.dirname(current_dir)
MODEL_V553 = os.path.join(BASE_DIR, 'models', 'stitch_v553_premium.json')
MODEL_PROMO = os.path.join(BASE_DIR, 'models', 'promosport_v553_enriched.json')
MODEL_UNIFIED = os.path.join(BASE_DIR, 'models', 'stitch_unified_v553.json')

_BOOSTER_CACHE = {}

def _load_booster(path, fnames=None):
    if path in _BOOSTER_CACHE:
        return _BOOSTER_CACHE[path]
    if not os.path.exists(path):
        print(f"[blended] Model not found: {path}", file=sys.stderr)
        return None
    import xgboost as xgb
    try:
        b = xgb.Booster()
        b.load_model(path)
        if fnames:
            b.set_param('feature_names', ','.join(fnames))
        _BOOSTER_CACHE[path] = b
        return b
    except Exception as e:
        print(f"[blended] Load error {path}: {e}", file=sys.stderr)
        return None


def predict(match, weights=None):
    """Blended prediction: tries V553 → Promosport → unified → fallback."""
    if weights is None:
        weights = {'v553': 0.6, 'promo': 0.3, 'unified': 0.1}

    result = {
        'home_win': 0.33, 'draw': 0.33, 'away_win': 0.34,
        'prediction': 'X', 'confidence': 0.0,
        'models_used': [], 'sources': {}
    }

    # Try V553 Premium
    try:
        from predict_v553 import predict as v553_predict
        v553_result = v553_predict(match)
        if v553_result.get('success'):
            probs = np.array([v553_result['home_win_prob'],
                              v553_result['draw_prob'],
                              v553_result['away_win_prob']])
            result['sources']['v553'] = probs.tolist()
            result['models_used'].append('v553')
    except Exception as e:
        print(f"[blended] V553 error: {e}", file=sys.stderr)

    # Try Promosport enriched
    try:
        from promosport_engine import predict_match
        promo_probs = predict_match(match)
        if promo_probs and len(promo_probs) == 3:
            result['sources']['promo'] = promo_probs
            result['models_used'].append('promo')
    except Exception as e:
        print(f"[blended] Promo error: {e}", file=sys.stderr)

    # Try unified model
    try:
        from ml_features import extract_ml_features, FEATURE_NAMES_V553
        feats = extract_ml_features(match, fetch_history=True)
        from top_analyst_engine import process_match_for_top_analyst
        ta = process_match_for_top_analyst(match)
        feats.update(ta.get('ml_features', {}))
        vec = np.array([[feats.get(f, 0.0) for f in FEATURE_NAMES_V553]], dtype=np.float32)
        booster = _load_booster(MODEL_UNIFIED, FEATURE_NAMES_V553)
        if booster:
            dmat = xgb.DMatrix(vec, feature_names=FEATURE_NAMES_V553)
            unified_probs = booster.predict(dmat)[0]
            result['sources']['unified'] = unified_probs.tolist()
            result['models_used'].append('unified')
    except Exception as e:
        print(f"[blended] Unified error: {e}", file=sys.stderr)

    # Blend
    if not result['models_used']:
        return result

    blended = np.zeros(3)
    total_w = 0.0
    for model_key, w in weights.items():
        if model_key in result['sources']:
            blended += w * np.array(result['sources'][model_key])
            total_w += w

    if total_w > 0:
        blended /= total_w
        pred_idx = int(np.argmax(blended))
        labels = {0: '1', 1: 'X', 2: '2'}
        result['home_win'] = float(blended[0])
        result['draw'] = float(blended[1])
        result['away_win'] = float(blended[2])
        result['prediction'] = labels[pred_idx]
        result['confidence'] = float(blended[pred_idx])

    return result


if __name__ == "__main__":
    import xgboost as xgb
    raw = sys.stdin.read()
    if raw.strip():
        match_data = json.loads(raw)
        result = predict(match_data)
        print(json.dumps(result, indent=2))
