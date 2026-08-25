"""
corners_calib.py — Probabilite O/U Corners via loi Negative Binomial calibree.

Le modele de corners (ml_ensemble) predit un total attendu de corners
(`expected_corners`, somme home+away). Pour en deduire P(Over ligne) on utilise
une Negative Binomial de moyenne mu=expected_corners et dispersion alpha fittee
sur l'historique (cf. train_corners.py -> data/corners_calibration.json).

Approche sans dependance (boucle PMF jusqu'au ligne) : robuste meme sans scipy.
"""
import json
import math
import os

_DEFAULT = {"n": 0, "mu": 10.6, "alpha": 0.45, "line": 9.5}


def load_calibration(path=None):
    if path is None:
        path = os.path.join(os.path.dirname(__file__), "..", "data", "corners_calibration.json")
    try:
        with open(path) as f:
            d = json.load(f)
        d.setdefault("line", 9.5)
        d.setdefault("alpha", 0.45)
        d.setdefault("mu", 10.6)
        return d
    except Exception:
        return dict(_DEFAULT)


def negbinom_pmf(k, mu, alpha):
    if alpha <= 0:
        alpha = 1e-3
    r = mu * mu / alpha
    if r <= 0:
        r = 1e-3
    p = r / (r + mu)
    if p <= 0 or p >= 1:
        return 0.0
    logc = math.lgamma(k + r) - math.lgamma(r) - math.lgamma(k + 1)
    return math.exp(logc + r * math.log(p) + k * math.log(1 - p))


def p_over_corner(mu, line, alpha=None, calib=None):
    """P(total corners > line) pour une Negative Binomial de moyenne mu."""
    if calib is None:
        calib = load_calibration()
    if alpha is None:
        alpha = calib.get("alpha", 0.45)
    try:
        mu = float(mu)
        line = float(line)
    except (TypeError, ValueError):
        return None
    if mu <= 0 or line < 0:
        return None
    kmax = int(math.floor(line))
    s = 0.0
    for k in range(0, kmax + 1):
        s += negbinom_pmf(k, mu, alpha)
    return max(0.0, min(1.0, 1.0 - s))


def p_under_corner(mu, line, alpha=None, calib=None):
    pov = p_over_corner(mu, line, alpha, calib)
    return None if pov is None else 1.0 - pov
