# -*- coding: utf-8 -*-
"""EXP OU refit — les poids actuels sont fittes sur des xG moyens de 4.6
(archive), servis avec des xG ~3.1 : refit sur xG a l'echelle actuelle.

Protocole honnete : split temporel 75/25 sur historical_matches sains,
fit sur TRAIN, UNE SEULE mesure sur TEST (courant vs refit vs refit+Platt
vs constante). Deploy seulement si TEST gagne.

Usage :
  python scripts/exp_ou_refit.py
Sortie :
  data/exp_ou_refit_report.json
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

from train_ou import fit as fit_logistic  # noqa: E402
from ou_model import ou_prob  # noqa: E402

DB = os.path.join(ROOT, "data", "tactical.db")
REPORT = os.path.join(ROOT, "data", "exp_ou_refit_report.json")
EPS = 1e-6
LINES = [2.5, 3.5]


def sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    return math.exp(z) / (1.0 + math.exp(z))


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


def apply_weights(total, blk):
    w, mu, sg = blk["w"], blk["mu"], blk["sigma"]
    x = (min(12.0, max(0.0, float(total))) - mu[0]) / sg[0]
    return sigmoid(w[0] * x + w[1])


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
        "SELECT scoreHome, scoreAway, "
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
        out.append({"total": xh + xa, "sh": sh, "sa": sa, "ts": ts})
    out.sort(key=lambda m: m["ts"])
    return out


def main():
    ms = load_rows()
    split = int(len(ms) * 0.75)
    train, test = ms[:split], ms[split:]
    print("[EXP] n=%d train=%d test=%d" % (len(ms), len(train), len(test)))
    report = {"n_train": len(train), "n_test": len(test), "lines": {}}
    for line in LINES:
        ytr = [1 if (m["sh"] + m["sa"]) > line else 0 for m in train]
        yte = [1 if (m["sh"] + m["sa"]) > line else 0 for m in test]
        Xtr = [m["total"] for m in train]
        Xte = [m["total"] for m in test]
        refit = fit_logistic(Xtr, ytr)
        cur = [(ou_prob(t, line), y) for t, y in zip(Xte, yte)]
        new = [(apply_weights(t, refit), y) for t, y in zip(Xte, yte)]
        ptr = [(apply_weights(t, refit), y) for t, y in zip(Xtr, ytr)]
        cal = fit_platt(ptr)
        newc = [(apply_platt(p, cal), y) for p, y in new]
        m_cur, m_new, m_newc = metrics(cur), metrics(new), metrics(newc)
        print("[EXP] L%.1f COURANT     : brier=%.4f ll=%.4f acc=%.4f" % (
            line, m_cur["brier"], m_cur["logloss"], m_cur["acc"]))
        print("[EXP] L%.1f REFIT       : brier=%.4f ll=%.4f acc=%.4f %s" % (
            line, m_new["brier"], m_new["logloss"], m_new["acc"], refit))
        print("[EXP] L%.1f REFIT+Platt : brier=%.4f ll=%.4f acc=%.4f a=%.3f" % (
            line, m_newc["brier"], m_newc["logloss"], m_newc["acc"], cal["a"]))
        report["lines"][str(line)] = {
            "current": m_cur, "refit": m_new, "refit_platt": m_newc,
            "refit_weights": refit, "platt": cal,
        }
    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print("[EXP] rapport -> %s" % REPORT)


if __name__ == "__main__":
    main()
