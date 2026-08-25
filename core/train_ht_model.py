"""
train_ht_model.py — Fit logistique P(HT > 0.5) par match sur l'archive (Q4 bis).

Label = (score_home_ht + score_away_ht) > 0. Features = [xg_home, xg_away,
corners_total, 1] standardisees. Gradient descent + L2. Sauve data/ht_model.json.
Compare log-loss modele vs baseline (taux HT global ~0.694).

Usage : python -m core.train_ht_model
"""
import json
import math
import os
import sqlite3

import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ARCHIVE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "historical_archive.sqlite")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "ht_model.json")


def sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    return math.exp(z) / (1.0 + math.exp(z))


def main():
    if not os.path.exists(ARCHIVE):
        print(f"[train_ht_model] archive introuvable : {ARCHIVE}")
        return
    con = sqlite3.connect(ARCHIVE)
    rows = con.execute(
        "SELECT score_home_ht, score_away_ht, xg_home, xg_away, corners_home, corners_away "
        "FROM archive_football_data WHERE xg_home IS NOT NULL AND xg_away IS NOT NULL "
        "AND score_home_ht IS NOT NULL AND score_away_ht IS NOT NULL"
    ).fetchall()
    con.close()
    n = len(rows)
    if n < 500:
        print(f"[train_ht_model] echantillon insuffisant ({n}) — abort")
        return
    X, y = [], []
    for shh, sah, xh, xa, ch, ca in rows:
        y.append(1 if (shh or 0) + (sah or 0) > 0 else 0)
        X.append([float(xh), float(xa), float((ch or 0) + (ca or 0))])

    p = sum(y) / n
    mu = [sum(c) / n for c in zip(*X)]
    sigma = [max(1e-6, math.sqrt(sum((v - m) ** 2 for v in col) / n)) for m, col in zip(mu, zip(*X))]
    Xs = [[(v - mu[k]) / sigma[k] for k, v in enumerate(xi)] + [1.0] for xi in X]

    w = [0.0, 0.0, 0.0, 0.0]
    lr, lam, epochs = 0.5, 0.01, 150
    for _ in range(epochs):
        gw = [0.0, 0.0, 0.0, 0.0]
        for xi, yi in zip(Xs, y):
            err = sigmoid(sum(wj * xij for wj, xij in zip(w, xi))) - yi
            for k in range(4):
                gw[k] += err * xi[k] + lam * w[k]
        for k in range(4):
            w[k] -= lr * gw[k] / n

    ll = 0.0
    for xi, yi in zip(Xs, y):
        pr = sigmoid(sum(wj * xij for wj, xij in zip(w, xi)))
        pr = max(1e-6, min(1 - 1e-6, pr))
        ll -= yi * math.log(pr) + (1 - yi) * math.log(1 - pr)
    ll /= n
    ll_base = -(p * math.log(p + 1e-6) + (1 - p) * math.log(1 - p + 1e-6))

    calib = {
        "w": [round(v, 4) for v in w],
        "mu": [round(v, 4) for v in mu],
        "sigma": [round(v, 4) for v in sigma],
        "n": n,
        "base_rate": round(p, 4),
        "logloss_model": round(ll, 4),
        "logloss_baseline": round(ll_base, 4),
        "features": ["xg_home", "xg_away", "corners_total", "intercept"],
    }
    with open(OUT, "w") as f:
        json.dump(calib, f, indent=2)
    print(f"[train_ht_model] n={n} base={p:.3f} logloss modele={ll:.4f} "
          f"baseline={ll_base:.4f} (gain={ll_base-ll:.4f})")
    print(f"[train_ht_model] -> {OUT}")


if __name__ == "__main__":
    main()
