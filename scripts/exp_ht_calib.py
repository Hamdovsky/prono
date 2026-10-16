# -*- coding: utf-8 -*-
"""EXP HT calibration — meme protocole honnete que E111 (split temporel 75/25,
Platt fittee sur TRAIN, UNE SEULE mesure sur TEST).

Usage :
  python scripts/exp_ht_calib.py
Sortie :
  data/exp_ht_calib_report.json
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

from ht_model import ht_prob  # noqa: E402

DB = os.path.join(ROOT, "data", "tactical.db")
REPORT = os.path.join(ROOT, "data", "exp_ht_calib_report.json")
EPS = 1e-6


def sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    return math.exp(z) / (1.0 + math.exp(z))


def fit_platt(pairs, iters=500, lr=0.5, l2=1e-4):
    xs = []
    ys = []
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
        "SELECT ht_score_home, ht_score_away, "
        "COALESCE(timestamp, archived_at, '') ts, fullData "
        "FROM historical_matches WHERE ht_score_home IS NOT NULL "
        "AND ht_score_away IS NOT NULL"
    ).fetchall()
    con.close()
    out = []
    for r in rows:
        try:
            y = 1 if (int(r["ht_score_home"]) + int(r["ht_score_away"])) > 0 else 0
        except (TypeError, ValueError):
            continue
        try:
            f = json.loads(r["fullData"] or "{}")
            xh, xa = float(f["home_xg"]), float(f["away_xg"])
        except (TypeError, ValueError, KeyError):
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
        out.append({"xg_h": xh, "xg_a": xa, "y": y, "ts": ts})
    if os.environ.get("SANE_XG", "0") == "1":
        before = len(out)
        out = [m for m in out if 0 <= m["xg_h"] <= 8 and 0 <= m["xg_a"] <= 8]
        print("[EXP] filtre sains: %d -> %d" % (before, len(out)))
    out.sort(key=lambda m: m["ts"])
    return out


def main():
    ms = load_rows()
    split = int(len(ms) * 0.75)
    train, test = ms[:split], ms[split:]
    print("[EXP] n=%d train=%d test=%d" % (len(ms), len(train), len(test)))
    tr = [(ht_prob(m["xg_h"], m["xg_a"]), m["y"]) for m in train]
    te = [(ht_prob(m["xg_h"], m["xg_a"]), m["y"]) for m in test]
    tr = [(p, y) for p, y in tr if p is not None]
    te = [(p, y) for p, y in te if p is not None]
    cal = fit_platt(tr)
    print("[EXP] Platt HT: a=%.4f b=%.4f (n=%d)" % (cal["a"], cal["b"], cal["n"]))
    raw_m = metrics(te)
    cal_m = metrics([(apply_platt(p, cal), y) for p, y in te])
    print("[EXP] HT TEST brut   :", raw_m)
    print("[EXP] HT TEST calibre:", cal_m)
    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump({"n_train": len(train), "n_test": len(test),
                   "raw": raw_m, "calibrated": cal_m, "platt": cal}, f, indent=2)
    print("[EXP] rapport -> %s" % REPORT)


if __name__ == "__main__":
    main()
