"""
btts_model.py — Probabilite BTTS data-driven (audit Q3).

Inference logistique pure-Python (sans numpy/sklearn) a partir de poids fitter
sur l'archive par train_btts.py -> data/btts_model.json. Remplace l'heuristique
`xg_h*xg_a*30 + 40` de market_engine quand BTTS_MODEL_ENABLED.

Features : [xg_home, xg_away, corners_total, 1] (intercept).
"""
import json
import math
import os

_DEFAULT_WEIGHTS = None


def _load_weights(path=None):
    if path is None:
        path = os.path.join(os.path.dirname(__file__), "..", "data", "btts_model.json")
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def _sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    return math.exp(z) / (1.0 + math.exp(z))


def btts_prob(xg_h, xg_a, corners_h=None, corners_a=None, weights=None):
    """P(BTTS) logistique. Si poids absents -> heuristique legacy (fallback)."""
    if weights is None:
        weights = _load_weights()
    if weights and isinstance(weights, dict) and "w" in weights:
        w = weights["w"]
        mu = weights.get("mu")
        sigma = weights.get("sigma")
        raw = [float(xg_h or 0), float(xg_a or 0), float((corners_h or 0) + (corners_a or 0))]
        if mu and sigma:
            x = [(v - mu[k]) / sigma[k] for k, v in enumerate(raw)] + [1.0]
        else:
            x = raw + [1.0]
        z = sum(wi * xi for wi, xi in zip(w, x))
        return _sigmoid(z)
    # Fallback heuristique (identique a market_engine legacy)
    eh = float(xg_h or 0)
    ea = float(xg_a or 0)
    return min(0.88, (eh * ea) * 30 / 100.0 + 0.40)


def has_model():
    return _load_weights() is not None
