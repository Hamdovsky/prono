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


def _load_recal(path=None):
    """Parametres Platt (a,b) fittes sur TRAIN honnete
    (scripts/exp_ou_btts_calib.py). None si absents : comportement inchange."""
    if path is None:
        path = os.path.join(os.path.dirname(__file__), "..", "data", "btts_calib.json")
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


_RECAL = None
_RECAL_LOADED = False


def _recal_params():
    global _RECAL, _RECAL_LOADED
    if not _RECAL_LOADED:
        _RECAL = _load_recal()
        _RECAL_LOADED = True
    return _RECAL


def apply_recal(p, recal=None):
    """Recalibration Platt : p -> sigmoid(a*logit(p)+b). Pure et testee.
    Sans parametres (fichier absent) : identite."""
    if recal is None:
        recal = _recal_params()
    if not recal or "a" not in recal or "b" not in recal:
        return p
    pc = min(1 - 1e-4, max(1e-4, p))
    return _sigmoid(recal["a"] * math.log(pc / (1 - pc)) + recal["b"])


def btts_prob(xg_h, xg_a, corners_h=None, corners_a=None, weights=None):
    """P(BTTS) logistique. Si poids absents -> heuristique legacy (fallback)."""
    # E112 : garde-fou d'echelle — l'archive contient des xG pourris
    # (jusqu'a 5e8). Sans clip, le sigmoid sature en certitude absurde.
    try:
        xg_h = min(8.0, max(0.0, float(xg_h if xg_h is not None else 0)))
        xg_a = min(8.0, max(0.0, float(xg_a if xg_a is not None else 0)))
    except (TypeError, ValueError):
        return 0.5
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
        raw = _sigmoid(z)
        # E111 : recalibration Platt. Sans fichier calib : identite.
        return apply_recal(raw)
    # Fallback heuristique (identique a market_engine legacy)
    eh = float(xg_h or 0)
    ea = float(xg_a or 0)
    return min(0.88, (eh * ea) * 30 / 100.0 + 0.40)


def has_model():
    return _load_weights() is not None
