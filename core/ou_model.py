"""
ou_model.py — Probabilite O/U (Over line) data-driven (audit Q5).

Inference logistique pure-Python pour P(total buts > line) a partir de
`total_xg` (et eventuellement ligne). Poids fitter par ligne par
train_ou.py -> data/ou_model.json. Remplace mc_ou25 brut dans market_engine
quand OU_MODEL_ENABLED.
"""
import json
import math
import os

_LINES = [2.5, 3.5]


def _load(path=None):
    if path is None:
        path = os.path.join(os.path.dirname(__file__), "..", "data", "ou_model.json")
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def _sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    return math.exp(z) / (1.0 + math.exp(z))


def ou_prob(total_xg, line=2.5, calib=None):
    """P(Over `line`) logistique sur total_xg. Fallback = None (appelant MC)."""
    if calib is None:
        calib = _load()
    key = f"L{line}"
    blk = calib.get(key) if calib else None
    if not blk or "w" not in blk:
        return None
    w = blk["w"]
    mu = blk.get("mu")
    sigma = blk.get("sigma")
    raw = [float(total_xg or 0)]
    if mu and sigma:
        x = [(raw[0] - mu[0]) / sigma[0], 1.0]
    else:
        x = [raw[0], 1.0]
    z = sum(wi * xi for wi, xi in zip(w, x))
    return _sigmoid(z)


def has_model():
    return _load() is not None
