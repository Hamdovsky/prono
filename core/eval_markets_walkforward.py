"""
eval_markets_walkforward.py — Validation chronologique des marches (audit A/E).

Compare le modele xG-logistique (BTTS, O/U, HT) au vrai estimateur par match :
Poisson/MC.calcule sur xg (proxy du Monte Carlo reel en production). Si le modele
bat le Poisson par match en log-loss, l'activation du gate est justifiee ; sinon
le MC reel reste superieur (gate OFF par defaut).

 walk-forward expansif (4 folds) : le modele est (re)fit sur le passe, evalue sur
le futur -> pas d'optimisme de leakage. Marches sans mu par-match archivee
(Corners, Cartons) ne sont pas evalues ici (deja calibrés en agrege par Q2/D).

Usage : python -m core.eval_markets_walkforward
"""
import math
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ARCHIVE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "historical_archive.sqlite")
FOLDS = 4


def sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    return math.exp(z) / (1.0 + math.exp(z))


def fit_logistic(X, y):
    n = len(X)
    if n < 50:
        return None
    d = len(X[0])
    mu = [sum(c) / n for c in zip(*X)]
    sigma = [max(1e-6, math.sqrt(sum((v - m) ** 2 for v in col) / n)) for m, col in zip(mu, zip(*X))]
    Xs = [[(v - mu[k]) / sigma[k] for k, v in enumerate(xi)] + [1.0] for xi in X]
    w = [0.0] * (d + 1)
    lr, lam, epochs = 0.5, 0.01, 120
    for _ in range(epochs):
        gw = [0.0] * (d + 1)
        for xi, yi in zip(Xs, y):
            err = sigmoid(sum(wj * xij for wj, xij in zip(w, xi))) - yi
            for k in range(d + 1):
                gw[k] += err * xi[k] + lam * w[k]
        for k in range(d + 1):
            w[k] -= lr * gw[k] / n
    return {"w": w, "mu": mu, "sigma": sigma, "n": n}


def predict_logistic(model, X):
    if model is None:
        return None
    w, mu, sigma = model["w"], model["mu"], model["sigma"]
    out = []
    for xi in X:
        xs = [(v - mu[k]) / sigma[k] for k, v in enumerate(xi)] + [1.0]
        out.append(sigmoid(sum(wj * xij for wj, xij in zip(w, xs))))
    return out


def poisson_p_gt(mu, k):
    p = 1.0
    for j in range(0, k + 1):
        if j == 0:
            term = math.exp(-mu)
        else:
            term *= mu / j
        p -= term
    return max(0.0, min(1.0, p))


def logloss(p, y):
    p = max(1e-6, min(1 - 1e-6, p))
    return -(y * math.log(p) + (1 - y) * math.log(1 - p))


def evaluate(name, rows, feat_fn, label_fn):
    rows = sorted(rows, key=lambda r: r.get("date") or "")
    n = len(rows)
    if n < 400:
        return
    step = n // FOLDS
    mll = fll = pll = 0.0
    cnt = 0
    for f in range(1, FOLDS):
        cut = step * f
        train = rows[:cut]
        test = rows[cut:]
        if not test:
            continue
        Xtr, ytr = [], []
        for r in train:
            fv = feat_fn(r)
            if fv is None:
                continue
            Xtr.append(fv)
            ytr.append(label_fn(r))
        model = fit_logistic(Xtr, ytr)
        base_rate = (sum(ytr) / len(ytr)) if ytr else 0.5
        Xte, yte = [], []
        for r in test:
            fv = feat_fn(r)
            if fv is None:
                continue
            Xte.append(fv)
            yte.append(label_fn(r))
        if not yte:
            continue
        preds = predict_logistic(model, Xte)
        for xi, yi in zip(Xte, yte):
            m = preds.pop(0) if preds else None
            p_pois = baseline_prob(name, xi)
            if m is not None:
                mll += logloss(m, yi)
            pll += logloss(p_pois, yi)
            fll += logloss(base_rate, yi)
            cnt += 1
    if cnt == 0:
        return
    print(f"  {name:<14} n_test={cnt:<6} modele={mll/cnt:.4f}  "
          f"Poisson/MC={pll/cnt:.4f}  flat={fll/cnt:.4f}  "
          f"gain_vs_MC={pll/cnt - mll/cnt:+.4f}")


def baseline_prob(name, xi):
    if name.startswith("BTTS"):
        xh, xa = xi[0], xi[1]
        return (1 - math.exp(-xh)) * (1 - math.exp(-xa))
    if name.startswith("OU2.5"):
        return poisson_p_gt(xi[0], 2)
    if name.startswith("OU3.5"):
        return poisson_p_gt(xi[0], 3)
    if name.startswith("HT"):
        xh, xa = xi[0], xi[1]
        return 1 - math.exp(-(xh + xa) * 0.45)
    return 0.5


def main():
    if not os.path.exists(ARCHIVE):
        print("[eval_markets] archive introuvable")
        return
    con = sqlite3.connect(ARCHIVE)
    con.row_factory = sqlite3.Row
    q = (
        "SELECT match_date AS date, xg_home, xg_away, corners_home, corners_away, "
        "yellow_home, yellow_away, score_home_ht, score_away_ht, score_home, score_away "
        "FROM archive_football_data WHERE xg_home IS NOT NULL AND xg_away IS NOT NULL "
        "AND score_home IS NOT NULL AND score_away IS NOT NULL "
        "AND match_date IS NOT NULL ORDER BY match_date"
    )
    rows = [dict(r) for r in con.execute(q).fetchall()]
    con.close()
    print(f"[eval_markets] rows={len(rows)} (walk-forward {FOLDS} folds, modele fit sur passe)")
    evaluate("BTTS", rows,
             lambda r: [r["xg_home"], r["xg_away"]],
             lambda r: 1 if (r["score_home"] > 0 and r["score_away"] > 0) else 0)
    evaluate("OU2.5", rows,
             lambda r: [r["xg_home"] + r["xg_away"]],
             lambda r: 1 if (r["score_home"] + r["score_away"]) > 2.5 else 0)
    evaluate("OU3.5", rows,
             lambda r: [r["xg_home"] + r["xg_away"]],
             lambda r: 1 if (r["score_home"] + r["score_away"]) > 3.5 else 0)
    evaluate("HT>0.5", rows,
             lambda r: [r["xg_home"], r["xg_away"],
                        (r["corners_home"] or 0) + (r["corners_away"] or 0)],
             lambda r: 1 if ((r["score_home_ht"] or 0) + (r["score_away_ht"] or 0)) > 0 else 0)
    print("[eval_markets] gain negatif => le MC/Poisson par match reste superieur "
          "(gate OFF justifie). gain positif => modele activable.")


if __name__ == "__main__":
    main()
