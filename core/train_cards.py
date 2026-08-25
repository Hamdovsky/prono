"""
train_cards.py — Calibrage dispersion Negative Binomial des cartons (audit D).

Lit archive_football_data (yellow_home + yellow_away) et fitte alpha tel que
Var = mu + alpha*mu^2. Sauve data/cards_calibration.json. Valide
P(Over 3.5) observee vs predite.

Usage : python -m core.train_cards
"""
import json
import math
import os
import sqlite3

import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.cards_calib import negbinom_pmf  # noqa: E402

ARCHIVE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "historical_archive.sqlite")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "cards_calibration.json")
LINE = 3.5


def main():
    if not os.path.exists(ARCHIVE):
        print(f"[train_cards] archive introuvable : {ARCHIVE}")
        return
    con = sqlite3.connect(ARCHIVE)
    rows = con.execute(
        "SELECT yellow_home, yellow_away FROM archive_football_data "
        "WHERE yellow_home IS NOT NULL AND yellow_away IS NOT NULL"
    ).fetchall()
    con.close()
    totals = [r[0] + r[1] for r in rows]
    n = len(totals)
    if n < 200:
        print(f"[train_cards] echantillon insuffisant ({n}) — abort")
        return
    mu = sum(totals) / n
    var = sum((t - mu) ** 2 for t in totals) / n
    alpha = max(0.01, (var - mu) / (mu * mu))
    over_obs = sum(1 for t in totals if t > LINE) / n
    s = 0.0
    for k in range(0, int(math.floor(LINE)) + 1):
        s += negbinom_pmf(k, mu, alpha)
    over_pred = max(0.0, min(1.0, 1.0 - s))
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
    print(f"[train_cards] n={n} mu={mu:.2f} var={var:.2f} alpha={alpha:.3f}")
    print(f"[train_cards] P(Over {LINE}) observee={over_obs:.3f} predite={over_pred:.3f} "
          f"(ecart={abs(over_obs-over_pred):.3f})")
    print(f"[train_cards] -> {OUT}")


if __name__ == "__main__":
    main()
