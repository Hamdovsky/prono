"""
train_ou.py — Fit logistique O/U par ligne sur l'archive (audit Q5).

Pour chaque ligne (2.5, 3.5) : label = (score_home+score_away) > ligne.
Features = [total_xg, 1] standardisees. Gradient descent + L2. Sauve
data/ou_model.json (poids + log-loss modele vs baseline par ligne).

Usage : python -m core.train_ou
"""
import json
import math
import os
import sqlite3

import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ARCHIVE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "historical_archive.sqlite")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "ou_model.json")
LINES = [2.5, 3.5]


def sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    return math.exp(z) / (1.0 + math.exp(z))


def fit(Xraw, y):
    n = len(y)
    mu0 = sum(Xraw) / n
    sigma0 = max(1e-6, math.sqrt(sum((v - mu0) ** 2 for v in Xraw) / n))
    Xs = [[(v - mu0) / sigma0, 1.0] for v in Xraw]
    p = sum(y) / n
    w = [0.0, 0.0]
    lr, lam, epochs = 0.5, 0.01, 120
    for _ in range(epochs):
        gw = [0.0, 0.0]
        for xi, yi in zip(Xs, y):
            err = sigmoid(sum(wj * xij for wj, xij in zip(w, xi))) - yi
            for k in range(2):
                gw[k] += err * xi[k] + lam * w[k]
        for k in range(2):
            w[k] -= lr * gw[k] / n
    ll = 0.0
    for xi, yi in zip(Xs, y):
        pr = sigmoid(sum(wj * xij for wj, xij in zip(w, xi)))
        pr = max(1e-6, min(1 - 1e-6, pr))
        ll -= yi * math.log(pr) + (1 - yi) * math.log(1 - pr)
    ll /= n
    ll_base = -(p * math.log(p + 1e-6) + (1 - p) * math.log(1 - p + 1e-6))
    return {
        "w": [round(v, 4) for v in w],
        "mu": [round(mu0, 4)],
        "sigma": [round(sigma0, 4)],
        "n": n,
        "base_rate": round(p, 4),
        "logloss_model": round(ll, 4),
        "logloss_baseline": round(ll_base, 4),
    }


def main():
    if not os.path.exists(ARCHIVE):
        print(f"[train_ou] archive introuvable : {ARCHIVE}")
        return
    con = sqlite3.connect(ARCHIVE)
    rows = con.execute(
        "SELECT score_home, score_away, xg_home, xg_away FROM archive_football_data "
        "WHERE xg_home IS NOT NULL AND xg_away IS NOT NULL"
    ).fetchall()
    con.close()
    n = len(rows)
    if n < 500:
        print(f"[train_ou] echantillon insuffisant ({n}) — abort")
        return
    total = [float(r[2]) + float(r[3]) for r in rows]
    calib = {}
    for line in LINES:
        y = [1 if (r[0] or 0) + (r[1] or 0) > line else 0 for r in rows]
        calib[f"L{line}"] = fit(total, y)
        b = calib[f"L{line}"]
        print(f"[train_ou] ligne {line} : n={b['n']} base={b['base_rate']:.3f} "
              f"logloss modele={b['logloss_model']:.4f} baseline={b['logloss_baseline']:.4f} "
              f"(gain={b['logloss_baseline']-b['logloss_model']:.4f})")
    with open(OUT, "w") as f:
        json.dump(calib, f, indent=2)
    print(f"[train_ou] -> {OUT}")


if __name__ == "__main__":
    main()
