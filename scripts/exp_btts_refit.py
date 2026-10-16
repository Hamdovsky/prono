# -*- coding: utf-8 -*-
"""EXP BTTS refit — memes poids gonfles qu'OU (mu 2.6/1.99 sur archive xG 4.6) :
refit sur xG a l'echelle actuelle, protocole honnete 75/25.

Usage :
  python scripts/exp_btts_refit.py
Sortie :
  data/exp_btts_refit_report.json
"""
import os
import sys
import json
import math
import sqlite3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE = os.path.join(ROOT, "core")
for p in (CORE, ROOT):
    if p not in sys.path:
        sys.path.insert(0, p)

from btts_model import btts_prob  # noqa: E402

DB = os.path.join(ROOT, "data", "tactical.db")
REPORT = os.path.join(ROOT, "data", "exp_btts_refit_report.json")
EPS = 1e-6


def sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    return math.exp(z) / (1.0 + math.exp(z))


def fit_logistic(X, y, iters=400, lr=0.5, l2=1e-3):
    n = len(X)
    d = len(X[0])
    mu = [sum(c) / n for c in zip(*X)]
    sg = [max(1e-6, math.sqrt(sum((v - m) ** 2 for v in col) / n))
          for m, col in zip(mu, zip(*X))]
    Xs = [[(v - mu[k]) / sg[k] for k, v in enumerate(xi)] + [1.0] for xi in X]
    w = [0.0] * (d + 1)
    for _ in range(iters):
        gw = [0.0] * (d + 1)
        for xi, yi in zip(Xs, y):
            err = sigmoid(sum(a * b for a, b in zip(w, xi))) - yi
            for k in range(d + 1):
                gw[k] += err * xi[k] + l2 * w[k]
        for k in range(d + 1):
            w[k] -= lr * gw[k] / n
    ll = 0.0
    for xi, yi in zip(Xs, y):
        pr = min(1 - 1e-6, max(1e-6, sigmoid(sum(a * b for a, b in zip(w, xi)))))
        ll -= yi * math.log(pr) + (1 - yi) * math.log(1 - pr)
    return {"w": [round(v, 4) for v in w],
            "mu": [round(v, 4) for v in mu],
            "sigma": [round(v, 4) for v in sg], "n": n,
            "logloss_model": round(ll / n, 4)}


def predict(model, x):
    xs = [(v - model["mu"][k]) / model["sigma"][k] for k, v in enumerate(x)] + [1.0]
    return sigmoid(sum(a * b for a, b in zip(model["w"], xs)))


def fit_platt(pairs, iters=500, lr=0.5, l2=1e-4):
    xs, ys = [], []
    for p, y in pairs:
        p = min(1 - 1e-4, max(1e-4, p))
        xs.append(math.log(p / (1 - p)))
        ys.append(y)
    a, b = 1.0, 0.0
    n = len(xs)
    for _ in range(iters):
        ga = gb = 0.0
        for x, y in zip(xs, ys):
            err = sigmoid(a * x + b) - y
            ga += err * x + l2 * a
            gb += err + l2 * b
        a -= lr * ga / n
        b -= lr * gb / n
    return {"a": a, "b": b, "n": n}


def apply_platt(p, c):
    p = min(1 - 1e-4, max(1e-4, p))
    return sigmoid(c["a"] * math.log(p / (1 - p)) + c["b"])


def metrics(pairs):
    n = len(pairs)
    brier = sum((p - y) ** 2 for p, y in pairs) / n
    ll = -sum(y * math.log(max(EPS, p)) + (1 - y) * math.log(max(EPS, 1 - p))
              for p, y in pairs) / n
    base = sum(y for _, y in pairs) / n
    bb = base * (1 - base) ** 2 + (1 - base) * base ** 2
    acc = sum(1 for p, y in pairs if (1 if p >= 0.5 else 0) == y) / n
    return {"n": n, "base": round(base, 4), "brier": round(brier, 4),
            "logloss": round(ll, 4), "floor": round(bb, 4),
            "acc": round(acc, 4), "majority": round(max(base, 1 - base), 4)}


def load_rows():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT scoreHome, scoreAway, corners_home, corners_away, "
        "COALESCE(timestamp, archived_at, '') ts, fullData "
        "FROM historical_matches WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL"
    ).fetchall()
    con.close()
    out = []
    for r in rows:
        try:
            sh, sa = int(r["scoreHome"]), int(r["scoreAway"])
            f = json.loads(r["fullData"] or "{}")
            xh, xa = float(f["home_xg"]), float(f["away_xg"])
        except (TypeError, ValueError, KeyError):
            continue
        if not (0 <= xh <= 8 and 0 <= xa <= 8):
            continue
        co = None
        try:
            if r["corners_home"] is not None and r["corners_away"] is not None:
                co = int(r["corners_home"]) + int(r["corners_away"])
        except (TypeError, ValueError):
            co = None
        ts = 0
        try:
            st = f.get("startTimestamp")
            if st:
                st = int(st)
                ts = st * 1000 if st < 1e12 else st
        except Exception:
            pass
        if not ts:
            try:
                from datetime import datetime
                ts = int(datetime.fromisoformat(
                    str(r["ts"]).replace("Z", "+00:00")).timestamp() * 1000)
            except Exception:
                ts = 0
        if not ts:
            continue
        out.append({"x": [xh, xa, co if co is not None else -1.0],
                    "corners_known": co is not None,
                    "y": 1 if (sh > 0 and sa > 0) else 0, "ts": ts})
    out.sort(key=lambda m: m["ts"])
    return out


def main():
    ms = load_rows()
    split = int(len(ms) * 0.75)
    train, test = ms[:split], ms[split:]
    cov = sum(1 for m in train if m["corners_known"]) / len(train)
    print("[EXP] n=%d train=%d test=%d corners_cov=%.3f" % (len(ms), len(train), len(test), cov))
    # E115-correction : le serving envoie corners=None->0 (btts_model raw).
    # Imputer la moyenne au train FAUSSE l'echelle (sigma ~0.29, poids
    # instable + mismatch serving). On encode 0.0 comme au serving.
    for m in train + test:
        if not m["corners_known"]:
            m["x"][2] = 0.0
    Xtr = [m["x"] for m in train]
    ytr = [m["y"] for m in train]
    refit = fit_logistic(Xtr, ytr)
    print("[EXP] REFIT %s" % refit)
    cur = [(btts_prob(m["x"][0], m["x"][1]), y) for m, y in
           zip(test, [m["y"] for m in test])]
    new = [(predict(refit, m["x"]), y) for m, y in
           zip(test, [m["y"] for m in test])]
    ptr = [(predict(refit, m["x"]), y) for m, y in
           zip(train, [m["y"] for m in train])]
    cal = fit_platt(ptr)
    newc = [(apply_platt(p, cal), y) for p, y in new]
    m_cur, m_new, m_newc = metrics(cur), metrics(new), metrics(newc)
    print("[EXP] COURANT     : brier=%.4f ll=%.4f acc=%.4f" % (
        m_cur["brier"], m_cur["logloss"], m_cur["acc"]))
    print("[EXP] REFIT       : brier=%.4f ll=%.4f acc=%.4f" % (
        m_new["brier"], m_new["logloss"], m_new["acc"]))
    print("[EXP] REFIT+Platt : brier=%.4f ll=%.4f acc=%.4f a=%.3f" % (
        m_newc["brier"], m_newc["logloss"], m_newc["acc"], cal["a"]))
    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump({"n_train": len(train), "n_test": len(test),
                   "corners_cov": round(cov, 4), "corners_encoding": "0.0-if-missing (serving parity)",
                   "current": m_cur, "refit": m_new, "refit_platt": m_newc,
                   "refit_weights": refit, "platt": cal}, f, indent=2)
    print("[EXP] rapport -> %s" % REPORT)


if __name__ == "__main__":
    main()
