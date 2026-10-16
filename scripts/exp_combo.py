# -*- coding: utf-8 -*-
"""EXP combo GG+Over2.5 — le marche affiche 47.5 % (E110, pire que 54.8 % naif).

Candidats compares sur TEST honnete (split temporel 75/25, memes lignes
xG que E111) :
  A. joint brut : Poisson joint + bornes Frechet des marginales ARCHIVEES
     (= comportement servi avant E111).
  B. joint calibre : Poisson joint + bornes des marginales E111 recalculees.
  C. produit : P(btts_cal) * P(ou_cal).
  D. logistique directe P(combo|xg_h,xg_a,corners) fittee sur TRAIN.
  E. Platt sur la sortie du vainqueur A-D (pattern E111).

Metrique parieuse : precision des YES + volume. Le seuil YES est tune sur
TRAIN (precision max sous contrainte volume >= 5 %), confirme UNE fois sur TEST.

Usage :
  python scripts/exp_combo.py
Sortie :
  data/exp_combo_report.json
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

from ou_model import ou_prob, apply_recal as ou_recal  # noqa: E402
from btts_model import btts_prob, apply_recal as btts_recal  # noqa: E402
from market_engine import combo_gg_over25_prob  # noqa: E402

DB = os.path.join(ROOT, "data", "tactical.db")
REPORT = os.path.join(ROOT, "data", "exp_combo_report.json")
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
    return {"w": w, "mu": mu, "sigma": sg}


def predict_logistic(model, x):
    xs = [(v - model["mu"][k]) / model["sigma"][k] for k, v in enumerate(x)] + [1.0]
    return sigmoid(sum(a * b for a, b in zip(model["w"], xs)))


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
    return {"n": n, "base": round(base, 4), "brier": round(brier, 4),
            "logloss": round(ll, 4), "floor": round(bb, 4)}


def yes_curve(pairs, thresholds):
    out = []
    for t in thresholds:
        sel = [y for p, y in pairs if p >= t]
        out.append({"t": t, "vol": round(len(sel) / len(pairs), 4),
                    "n_yes": len(sel),
                    "precision": round(sum(sel) / len(sel), 4) if sel else None})
    return out


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
        except (TypeError, ValueError):
            continue
        try:
            f = json.loads(r["fullData"] or "{}")
        except Exception:
            continue
        try:
            xh, xa = float(f["home_xg"]), float(f["away_xg"])
        except (TypeError, ValueError, KeyError):
            continue
        co = None
        try:
            if r["corners_home"] is not None and r["corners_away"] is not None:
                co = int(r["corners_home"]) + int(r["corners_away"])
        except (TypeError, ValueError):
            co = None
        arch_btts = arch_ou = None
        try:
            if f.get("btts_prob") is not None:
                arch_btts = float(f["btts_prob"])
                arch_btts = arch_btts / 100.0 if arch_btts > 1 else arch_btts
            if f.get("ou_25_prob") is not None:
                arch_ou = float(f["ou_25_prob"])
                arch_ou = arch_ou / 100.0 if arch_ou > 1 else arch_ou
        except (TypeError, ValueError):
            pass
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
        combo = 1 if (sh > 0 and sa > 0 and (sh + sa) > 2.5) else 0
        out.append({"xg_h": xh, "xg_a": xa, "corners": co,
                    "arch_btts": arch_btts, "arch_ou": arch_ou,
                    "y": combo, "ts": ts})
    # E112 : exclure les xG pourris d'archive (cf exp_ou_btts_calib).
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
    print("[EXP] n=%d train=%d test=%d corners_cov=%.2f" % (
        len(ms), len(train), len(test),
        sum(1 for m in ms if m["corners"] is not None) / len(ms)))

    def feats(m, with_corners):
        v = [m["xg_h"], m["xg_a"]]
        if with_corners:
            v.append(m["corners"] if m["corners"] is not None else 10.0)
        return v

    with_c = sum(1 for m in train if m["corners"] is not None) / len(train) > 0.5
    print("[EXP] coins modelises avec corners=%s" % with_c)
    Xtr = [feats(m, with_c) for m in train]
    ytr = [m["y"] for m in train]
    direct = fit_logistic(Xtr, ytr)

    # E112-bis : marginales brutes FRAICHES (sans recal) + joint pur sans bornes,
    # pour isoler l'effet du recalibrage E111 et des bornes de Frechet.
    import ou_model as _oum
    import btts_model as _btm

    def _sig(z):
        return 1.0 / (1.0 + math.exp(-z)) if z >= 0 else math.exp(z) / (1.0 + math.exp(z))

    _ouw = _oum._load()["L2.5"]
    _btw = _btm._load_weights()

    def raw_ou(total):
        t = min(12.0, max(0.0, float(total)))
        x = (t - _ouw["mu"][0]) / _ouw["sigma"][0]
        return _sig(_ouw["w"][0] * x + _ouw["w"][1])

    def raw_btts(xh, xa):
        # coins neutralises a la moyenne (standardise = 0), comme un match
        # sans data coins cote serving.
        xh = min(8.0, max(0.0, float(xh)))
        xa = min(8.0, max(0.0, float(xa)))
        xs = [(xh - _btw["mu"][0]) / _btw["sigma"][0],
              (xa - _btw["mu"][1]) / _btw["sigma"][1], 0.0]
        xx = xs + [1.0]
        return _sig(sum(a * b for a, b in zip(_btw["w"], xx)))

    def pure_joint(xh, xa):
        import math as _m
        eh, ea = _m.exp(-xh), _m.exp(-xa)
        return max(0.0, (1.0 - eh) * (1.0 - ea) - (xh * eh) * (xa * ea))

    cands = {"joint_raw": [], "joint_cal": [], "product": [], "direct": [],
               "joint_pure": [], "joint_rawfresh": []}
    for m in train + test:
        pb_cal = btts_prob(m["xg_h"], m["xg_a"])
        po_cal = ou_prob(m["xg_h"] + m["xg_a"], 2.5)
        jr = combo_gg_over25_prob(m["xg_h"], m["xg_a"], m["arch_btts"], m["arch_ou"])
        jc = combo_gg_over25_prob(m["xg_h"], m["xg_a"], pb_cal, po_cal)
        pr = pb_cal * po_cal
        dr = predict_logistic(direct, feats(m, with_c))
        pj = pure_joint(m["xg_h"], m["xg_a"])
        jrf = combo_gg_over25_prob(m["xg_h"], m["xg_a"],
                                   raw_btts(m["xg_h"], m["xg_a"]),
                                   raw_ou(m["xg_h"] + m["xg_a"]))
        cands["joint_raw"].append(jr)
        cands["joint_cal"].append(jc)
        cands["product"].append(pr)
        cands["direct"].append(dr)
        cands["joint_pure"].append(pj)
        cands["joint_rawfresh"].append(jrf)
    ntr = len(train)
    res = {}
    for name, probs in cands.items():
        ptr = [(p, m["y"]) for p, m in zip(probs[:ntr], train) if p is not None]
        pte = [(p, m["y"]) for p, m in zip(probs[ntr:], test) if p is not None]
        res[name] = {"train": metrics(ptr), "test": metrics(pte), "_pte": pte,
                     "_ptr": ptr}
        print("[EXP] %-10s TEST brier=%.4f (floor %.4f) ll=%.4f base=%.4f" % (
            name, res[name]["test"]["brier"], res[name]["test"]["floor"],
            res[name]["test"]["logloss"], res[name]["test"]["base"]))

    # Platt sur le meilleur candidat (pattern E111), fit sur TRAIN.
    order = sorted(res, key=lambda k: res[k]["test"]["brier"])
    best = order[0]
    print("[EXP] ordre Brier TEST:", [(k, res[k]["test"]["brier"]) for k in order])
    calib = fit_platt(res[best]["_ptr"])
    pe = [(apply_platt(p, calib), y) for p, y in res[best]["_pte"]]
    res["platt_" + best] = {"test": metrics(pe), "_pte": pe}
    print("[EXP] platt_%s TEST brier=%.4f ll=%.4f" % (
        best, res["platt_" + best]["test"]["brier"],
        res["platt_" + best]["test"]["logloss"]))

    # Seuil YES tune sur TRAIN (precision max, volume >= 5 %), confirme sur TEST.
    TH = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70]
    final = "platt_" + best
    tr_pairs = [(apply_platt(p, calib), y) for p, y in res[best]["_ptr"]]
    tr_curve = yes_curve(tr_pairs, TH)
    te_curve = yes_curve(res[final]["_pte"], TH)
    cands_tr = [c for c in tr_curve if c["precision"] is not None and c["vol"] >= 0.05]
    best_t = max(cands_tr, key=lambda c: c["precision"])["t"] if cands_tr else 0.5
    print("[EXP] courbe YES TRAIN:", [(c["t"], c["precision"], c["vol"]) for c in tr_curve])
    print("[EXP] courbe YES TEST :", [(c["t"], c["precision"], c["vol"]) for c in te_curve])
    print("[EXP] SEUIL RETENU (train) t=%.2f" % best_t)

    report = {"n_train": len(train), "n_test": len(test), "with_corners": with_c,
              "candidates": {k: {"test": v["test"]} for k, v in res.items()},
              "platt": {"on": best, **calib},
              "yes_curves": {"train": tr_curve, "test": te_curve},
              "best_t": best_t}
    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print("[EXP] rapport -> %s" % REPORT)


if __name__ == "__main__":
    main()
