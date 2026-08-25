"""
ht_model.py — Probabilite But 1ere mi-temps (O/U 0.5) par match (audit Q4 bis).

Inference logistique pure-Python (sans numpy/sklearn) a partir de poids fitter
sur l'archive par train_ht_model.py -> data/ht_model.json. Remplace le prior par
ligue (marketPolicy.HT_RATIOS) par une estimation par match quand `ht_goal_prob`
est fourni au pipeline. Features : [xg_home, xg_away, corners_total, 1].
"""
import json
import math
import os


def _load(path=None):
    if path is None:
        path = os.path.join(os.path.dirname(__file__), "..", "data", "ht_model.json")
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def _sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    return math.exp(z) / (1.0 + math.exp(z))


def ht_prob(xg_h, xg_a, corners_total=None, weights=None):
    """P(HT > 0.5) logistique. Si poids absents -> None (appelant utilise le prior)."""
    if weights is None:
        weights = _load()
    if not weights or "w" not in weights:
        return None
    w = weights["w"]
    mu = weights.get("mu")
    sigma = weights.get("sigma")
    raw = [float(xg_h or 0), float(xg_a or 0), float((corners_total or 0))]
    if mu and sigma:
        x = [(raw[k] - mu[k]) / sigma[k] for k in range(3)] + [1.0]
    else:
        x = raw + [1.0]
    z = sum(wi * xi for wi, xi in zip(w, x))
    return _sigmoid(z)


def has_model():
    return _load() is not None
