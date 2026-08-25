"""
cards_calib.py — Probabilite O/U Cartons via Negative Binomial calibree (audit D).

`expected_cards` (somme jaunes estimee, ml_ensemble) = moyenne mu. Dispersion
alpha fittee sur l'archive (yellow_home+yellow_away). PMF en boucle (sans scipy).
Ligne de reference : 3.5 (Over/Under 3.5 Cartons).
"""
import json
import math
import os

_DEFAULT = {"n": 0, "mu": 4.6, "alpha": 0.35, "line": 3.5}


def load_calibration(path=None):
    if path is None:
        path = os.path.join(os.path.dirname(__file__), "..", "data", "cards_calibration.json")
    try:
        with open(path) as f:
            d = json.load(f)
        d.setdefault("line", 3.5)
        d.setdefault("alpha", 0.35)
        d.setdefault("mu", 4.6)
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


def p_over_cards(mu, line, alpha=None, calib=None):
    if calib is None:
        calib = load_calibration()
    if alpha is None:
        alpha = calib.get("alpha", 0.35)
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


def p_under_cards(mu, line, alpha=None, calib=None):
    pov = p_over_cards(mu, line, alpha, calib)
    return None if pov is None else 1.0 - pov
