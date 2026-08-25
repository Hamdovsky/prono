"""
train_btts.py — Fit logistique BTTS sur l'archive (audit Q3).

Lit archive_football_data (score_home/away -> label BTTS, xg_home/away,
corners_home/away -> features). Gradient descent pur Python (sans numpy). Sauve
data/btts_model.json (poids + log-loss modele vs baseline constant). Compare au
baseline (taux BTTS global) et a l'heuristique legacy.

Usage : python -m core.train_btts
"""
import json
import math
import os
import sqlite3

import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ARCHIVE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "historical_archive.sqlite")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "btts_model.json")


def sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    return math.exp(z) / (1.0 + math.exp(z))


def main():
    if not os.path.exists(ARCHIVE):
        print(f"[train_btts] archive introuvable : {ARCHIVE}")
        return
    con = sqlite3.connect(ARCHIVE)
    rows = con.execute(
        "SELECT score_home, score_away, xg_home, xg_away, corners_home, corners_away "
        "FROM archive_football_data WHERE xg_home IS NOT NULL AND xg_away IS NOT NULL"
    ).fetchall()
    con.close()
    n = len(rows)
    if n < 500:
        print(f"[train_btts] echantillon insuffisant ({n}) — abort")
        return

    X, y = [], []
    for sh, sa, xh, xa, ch, ca in rows:
        btts = 1 if (sh or 0) > 0 and (sa or 0) > 0 else 0
        X.append([float(xh), float(xa), float((ch or 0) + (ca or 0))])
        y.append(btts)

    p = sum(y) / n  # base rate

    # Standardisation des features (evite l'overconfidence du logistique sur xG bruts)
    mu = [sum(c) / n for c in zip(*X)]
    sigma = [max(1e-6, math.sqrt(sum((v - m) ** 2 for v in col) / n)) for m, col in zip(mu, zip(*X))]
    Xs = [[(v - mu[k]) / sigma[k] for k, v in enumerate(xi)] + [1.0] for xi in X]

    # Gradient descent (logistic) avec petite regularisation L2
    w = [0.0, 0.0, 0.0, 0.0]
    lr = 0.5
    lam = 0.01
    epochs = 120
    for _ in range(epochs):
        gw = [0.0, 0.0, 0.0, 0.0]
        for xi, yi in zip(Xs, y):
            z = sum(wj * xij for wj, xij in zip(w, xi))
            err = sigmoid(z) - yi
            for k in range(4):
                gw[k] += err * xi[k] + lam * w[k]
        for k in range(4):
            w[k] -= lr * gw[k] / n

    # Log-loss modele vs baseline constant p
    ll_model = 0.0
    for xi, yi in zip(Xs, y):
        z = sum(wj * xij for wj, xij in zip(w, xi))
        pr = sigmoid(z)
        pr = max(1e-6, min(1 - 1e-6, pr))
        ll_model -= yi * math.log(pr) + (1 - yi) * math.log(1 - pr)
    ll_model /= n
    ll_base = -(p * math.log(p + 1e-6) + (1 - p) * math.log(1 - p + 1e-6))

    calib = {
        "w": [round(v, 4) for v in w],
        "mu": [round(v, 4) for v in mu],
        "sigma": [round(v, 4) for v in sigma],
        "n": n,
        "base_rate": round(p, 4),
        "logloss_model": round(ll_model, 4),
        "logloss_baseline": round(ll_base, 4),
        "features": ["xg_home", "xg_away", "corners_total", "intercept"],
    }
    with open(OUT, "w") as f:
        json.dump(calib, f, indent=2)
    print(f"[train_btts] n={n} base_rate={p:.3f} logloss modele={ll_model:.4f} "
          f"baseline={ll_base:.4f} (gain={ll_base-ll_model:.4f})")
    print(f"[train_btts] poids w={calib['w']}")
    print(f"[train_btts] -> {OUT}")


if __name__ == "__main__":
    main()
