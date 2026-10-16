# -*- coding: utf-8 -*-
"""EXP OU/BTTS calibration — les probas logistiques sur xG sont-elles
etalonnees ? (audit E110 : OU 55.2 % vs 57.8 % naif sur archives)

Protocole honnete (miroir de core/ou_model.py:main) :
  1) Split temporel 75/25 sur historical_matches (memes lignes que ou_model).
  2) Fit Platt (a,b) sur TRAIN uniquement, a partir des probas brutes
     recalculees (ou_prob/btts_prob actuels, pas de fuite).
  3) UNE SEULE mesure sur TEST : Brier/logloss/acc@50 de brut vs calibre
     vs constante. Le chiffre TEST decide.

Usage :
  python scripts/exp_ou_btts_calib.py
Sortie :
  data/exp_ou_btts_calib_report.json (+ fichiers calib seulement si gain TEST)
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

from ou_model import ou_prob  # noqa: E402
from btts_model import btts_prob  # noqa: E402

DB = os.path.join(ROOT, "data", "tactical.db")
REPORT = os.path.join(ROOT, "data", "exp_ou_btts_calib_report.json")
EPS = 1e-6


def sigmoid(z):
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    return math.exp(z) / (1.0 + math.exp(z))


def fit_platt(pairs, iters=500, lr=0.5, l2=1e-4):
    """Regression logistique 1D sur logit(p) : P(y) = sigmoid(a*logit(p)+b)."""
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


def apply_platt(p, calib):
    p = min(1 - 1e-4, max(1e-4, p))
    return sigmoid(calib["a"] * math.log(p / (1 - p)) + calib["b"])


def metrics(pairs):
    n = len(pairs)
    brier = sum((p - y) ** 2 for p, y in pairs) / n
    ll = -sum(y * math.log(max(EPS, p)) + (1 - y) * math.log(max(EPS, 1 - p))
              for p, y in pairs) / n
    base = sum(y for _, y in pairs) / n
    bb = base * (1 - base) ** 2 + (1 - base) * base ** 2
    acc = sum(1 for p, y in pairs if (1 if p >= 0.5 else 0) == y) / n
    maj = max(base, 1 - base)
    return {"n": n, "base": round(base, 4), "brier": round(brier, 4),
            "logloss": round(ll, 4), "floor": round(bb, 4), "acc": round(acc, 4),
            "majority": round(maj, 4)}


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
        except (TypeError, ValueError):
            continue
        xg_h = xg_a = None
        ts = 0
        try:
            f = json.loads(r["fullData"] or "{}")
            xg_h = f.get("home_xg")
            xg_a = f.get("away_xg")
            st = f.get("startTimestamp")
            if st:
                st = int(st)
                ts = st * 1000 if st < 1e12 else st
        except Exception:
            pass
        if xg_h is None or xg_a is None:
            continue
        if not ts:
            try:
                from datetime import datetime
                ts_raw = r["ts"] or ""
                ts = int(datetime.fromisoformat(
                    str(ts_raw).replace("Z", "+00:00")).timestamp() * 1000)
            except Exception:
                ts = 0
        try:
            xg_h, xg_a = float(xg_h), float(xg_a)
        except (TypeError, ValueError):
            continue
        out.append({"xg_h": xg_h, "xg_a": xg_a, "sh": sh, "sa": sa, "ts": ts})
    out = [m for m in out if m["ts"] > 0]
    # E112 : l'archive contient ~4 % de xG pourris (jusqu'a 5e8). SANE_XG=1
    # les exclut pour fitter sur du signal reel uniquement.
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

    ou_tr, ou_te, bt_tr, bt_te = [], [], [], []
    for m in train:
        ou_tr.append((ou_prob(m["xg_h"] + m["xg_a"], 2.5),
                      1 if (m["sh"] + m["sa"]) > 2.5 else 0))
        bt_tr.append((btts_prob(m["xg_h"], m["xg_a"]),
                      1 if (m["sh"] > 0 and m["sa"] > 0) else 0))
    for m in test:
        ou_te.append((ou_prob(m["xg_h"] + m["xg_a"], 2.5),
                      1 if (m["sh"] + m["sa"]) > 2.5 else 0))
        bt_te.append((btts_prob(m["xg_h"], m["xg_a"]),
                      1 if (m["sh"] > 0 and m["sa"] > 0) else 0))
    ou_tr = [(p, y) for p, y in ou_tr if p is not None]
    ou_te = [(p, y) for p, y in ou_te if p is not None]

    ou_cal = fit_platt(ou_tr)
    bt_cal = fit_platt(bt_tr)
    print("[EXP] Platt OU: a=%.4f b=%.4f (n=%d)" % (ou_cal["a"], ou_cal["b"], ou_cal["n"]))
    print("[EXP] Platt BTTS: a=%.4f b=%.4f (n=%d)" % (bt_cal["a"], bt_cal["b"], bt_cal["n"]))

    ou_raw = metrics(ou_te)
    ou_cal_m = metrics([(apply_platt(p, ou_cal), y) for p, y in ou_te])
    bt_raw = metrics(bt_te)
    bt_cal_m = metrics([(apply_platt(p, bt_cal), y) for p, y in bt_te])
    print("[EXP] OU TEST brut   :", ou_raw)
    print("[EXP] OU TEST calibre:", ou_cal_m)
    print("[EXP] BTTS TEST brut   :", bt_raw)
    print("[EXP] BTTS TEST calibre:", bt_cal_m)

    report = {
        "n_train": len(train), "n_test": len(test),
        "ou": {"raw": ou_raw, "calibrated": ou_cal_m, "platt": ou_cal},
        "btts": {"raw": bt_raw, "calibrated": bt_cal_m, "platt": bt_cal},
    }
    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print("[EXP] rapport -> %s" % REPORT)


if __name__ == "__main__":
    main()
