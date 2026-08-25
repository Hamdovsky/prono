"""
train_corners.py — Calibrage de la dispersion Negative Binomial des corners.

Lit l'historique (archive_football_data : corners_home + corners_away) et fitte
la dispersion alpha telle que Var = mu + alpha*mu^2 (parametrisation NB). Sauve
data/corners_calibration.json consomme par corners_calib.p_over_corner.

Validation honnete : comparaison P(Over 9.5) observee vs predite (la meme ligne
que deriveCornerPick / market_engine). Aucun leackage : statistiques globales.

Usage : python -m core.train_corners
"""
import json
import math
import os
import sqlite3

import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.corners_calib import negbinom_pmf  # noqa: E402

ARCHIVE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "historical_archive.sqlite")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "corners_calibration.json")
LINE = 9.5


def fit_alpha(totals):
    n = len(totals)
    mu = sum(totals) / n
    var = sum((t - mu) ** 2 for t in totals) / n
    alpha = (var - mu) / (mu * mu) if mu > 0 else 0.0
    alpha = max(0.01, alpha)
    return mu, var, alpha, n


def p_over_theoretical(mu, alpha, line):
    s = 0.0
    for k in range(0, int(math.floor(line)) + 1):
        s += negbinom_pmf(k, mu, alpha)
    return max(0.0, min(1.0, 1.0 - s))


def main():
    if not os.path.exists(ARCHIVE):
        print(f"[train_corners] archive introuvable : {ARCHIVE}")
        return
    con = sqlite3.connect(ARCHIVE)
    rows = con.execute(
        "SELECT corners_home, corners_away FROM archive_football_data "
        "WHERE corners_home IS NOT NULL AND corners_away IS NOT NULL"
    ).fetchall()
    con.close()
    totals = [r[0] + r[1] for r in rows]
    if len(totals) < 200:
        print(f"[train_corners] echantillon insuffisant ({len(totals)} lignes) — abort")
        return
    mu, var, alpha, n = fit_alpha(totals)

    # Validation : P(Over LINE) observee vs predite
    over_obs = sum(1 for t in totals if t > LINE) / n
    over_pred = p_over_theoretical(mu, alpha, LINE)

    calib = {
        "n": n,
        "mu": round(mu, 4),
        "alpha": round(alpha, 4),
        "line": LINE,
        "variance": round(var, 4),
        "p_over_observed": round(over_obs, 4),
        "p_over_predicted": round(over_pred, 4),
    }
    with open(OUT, "w") as f:
        json.dump(calib, f, indent=2)
    print(f"[train_corners] n={n} mu={mu:.2f} var={var:.2f} alpha={alpha:.3f}")
    print(f"[train_corners] P(Over {LINE}) observee={over_obs:.3f} predite={over_pred:.3f} "
          f"(ecart={abs(over_obs-over_pred):.3f})")
    print(f"[train_corners] -> {OUT}")


if __name__ == "__main__":
    main()
