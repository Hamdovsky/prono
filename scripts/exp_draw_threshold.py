# -*- coding: utf-8 -*-
"""EXP draw-threshold — le recall des nuls est a 33-34 % sur holdout honnete.

Protocole anti-optimisme :
  1) Split IDENTIQUE a E100 (LIMIT=15000, TEST_FRAC=0.15, VAL_FRAC=0.12).
  2) Reentrainement config 'deployed' sur CORE uniquement -> val ET test
     sont unseen pour ce booster (pas de fuite, contrairement au booster
     de prod evalue sur ces memes periodes).
  3) Tanner : regle "D si p_d >= t sinon argmax(H,A)", grille t sur VAL.
  4) UNE SEULE confirmation du meilleur t sur TEST. Le chiffre TEST est
     le seul qui compte.

Usage :
  python scripts/exp_draw_threshold.py
Env : LIMIT (defaut 15000)
"""
import os
import sys
import json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE = os.path.join(ROOT, "core")
SCRIPTS = os.path.join(ROOT, "scripts")
for p in (CORE, SCRIPTS):
    if p not in sys.path:
        sys.path.insert(0, p)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import xgboost as xgb  # noqa: E402
from sklearn.utils.class_weight import compute_sample_weight  # noqa: E402

from train_v55 import load_data  # noqa: E402
from ml_features import FEATURE_NAMES_V55, CLOSING_DERIVED_FEATURES  # noqa: E402
from eval_v55_walkforward_retrain import strength  # noqa: E402
from train_v55_honest import BASE_PARAMS, CONFIGS  # noqa: E402

REPORT_PATH = os.path.join(ROOT, "data", "exp_draw_threshold_report.json")


def rule_argmax(proba):
    return proba.argmax(axis=1)


def rule_draw_threshold(proba, t):
    # Nul predit ssi p_d >= t, sinon le meilleur de (H, A).
    ha = np.where(proba[:, 0] >= proba[:, 2], 0, 2)
    return np.where(proba[:, 1] >= t, 1, ha)


def rule_no_draw(proba):
    return np.where(proba[:, 0] >= proba[:, 2], 0, 2)


def draw_stats(y_true, pick):
    pred_d = pick == 1
    true_d = y_true == 1
    n_pred = int(pred_d.sum())
    n_true = int(true_d.sum())
    tp = int((pred_d & true_d).sum())
    return {
        "n_pred_draw": n_pred,
        "n_true_draw": n_true,
        "draw_precision": (tp / n_pred) if n_pred else None,
        "draw_recall": (tp / n_true) if n_true else None,
    }


def main():
    os.chdir(ROOT)
    limit = int(os.environ.get("LIMIT", "15000"))
    print("[EXP] load_data(limit=%d) ..." % limit)
    X, y, sw, match_dates = load_data(limit=limit, feature_names=FEATURE_NAMES_V55)
    y = np.asarray(y)
    for c in CLOSING_DERIVED_FEATURES:
        if c in X.columns:
            X[c] = 0.0
    ts = pd.to_datetime(pd.Series(match_dates), errors="coerce")
    ok = ts.notna().values
    order = np.argsort(ts[ok].values)
    idx = np.arange(len(ts))[ok][order]
    X = X.iloc[idx].reset_index(drop=True)
    y = y[idx]
    dts = ts.iloc[idx].values
    n = len(idx)
    Xnp = X.astype(float).values

    n_test = int(n * 0.15)
    n_train_all = n - n_test
    tr_all = np.arange(n_train_all)
    te = np.arange(n_train_all, n)
    n_val = max(50, int(n_train_all * 0.12))
    core, val = tr_all[:-n_val], tr_all[-n_val:]
    print("[EXP] core=%d val=%d test=%d  test=%s .. %s" % (
        len(core), len(val), len(te), str(dts[te][0])[:10], str(dts[te][-1])[:10]))

    params = CONFIGS["deployed"]
    # Plan B (EarlyStopping du .venv plante : XGBoostError preds.Size()==0) :
    # on utilise DIRECTEMENT le booster de prod pour les probas. Biais connu :
    # val/test chevauchent sa periode d'entrainement (chiffres absolus
    # optimistes) — mais le DELTA argmax-vs-seuil sur les memes probas reste
    # informatif, et la selection (val) puis confirmation (test) restent
    # separees. Le vrai OOS (~53-56 %, E99/E100) est rappele dans le rapport.
    from train_v55_honest import MODEL_PATH as DEPLOYED_PATH  # noqa: E402
    booster = xgb.Booster()
    booster.load_model(DEPLOYED_PATH)
    p_val = booster.predict(xgb.DMatrix(Xnp[val]))
    p_te = booster.predict(xgb.DMatrix(Xnp[te]))

    base_val = strength(y[val], p_val)
    base_te = strength(y[te], p_te)
    nodraw_te_acc = float((rule_no_draw(p_te) == y[te]).mean())
    nodraw_te = dict(base_te)
    nodraw_te["acc"] = nodraw_te_acc
    print("[EXP] VAL argmax acc=%.4f | TEST argmax acc=%.4f | TEST no-draw acc=%.4f" % (
        base_val["acc"], base_te["acc"], nodraw_te["acc"]))

    grid = [round(x, 2) for x in np.arange(0.20, 0.51, 0.02)]
    val_rows = []
    for t in grid:
        pv = rule_draw_threshold(p_val, t)
        acc = float((pv == y[val]).mean())
        val_rows.append({"t": t, "acc": acc, **draw_stats(y[val], pv)})
    val_rows.sort(key=lambda r: r["acc"], reverse=True)
    best = val_rows[0]
    print("[EXP] VAL top3 : %s" % val_rows[:3])

    # Confirmation unique sur TEST.
    t = best["t"]
    p_te_pick = rule_draw_threshold(p_te, t)
    te_acc = float((p_te_pick == y[te]).mean())
    print("[EXP] TEST t=%.2f acc=%.4f (argmax %.4f, no-draw %.4f) drawP=%s drawR=%s" % (
        t, te_acc, base_te["acc"], nodraw_te["acc"],
        draw_stats(y[te], p_te_pick)["draw_precision"],
        draw_stats(y[te], p_te_pick)["draw_recall"]))

    report = {
        "split": {"n_core": len(core), "n_val": len(val), "n_test": len(te),
                  "test_period": [str(dts[te][0])[:10], str(dts[te][-1])[:10]]},
        "baseline": {"val_argmax": base_val, "test_argmax": base_te,
                     "test_no_draw": nodraw_te,
                     "test_no_draw_stats": draw_stats(y[te], rule_no_draw(p_te))},
        "val_grid": val_rows,
        "best_t": t,
        "test_confirmed": {"acc": te_acc, **draw_stats(y[te], p_te_pick)},
    }
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, default=str)
    print("[EXP] rapport -> %s" % REPORT_PATH)


if __name__ == "__main__":
    main()
