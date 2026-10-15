# -*- coding: utf-8 -*-
"""E99 — Walk-forward 1X2 AVEC réentraînement (contrôle de fuite).

But : trancher la question « le ~59-60 % OOS mesuré pour le modèle servi V55
est-il réel ou dû à une fuite ? ». Le modèle déployé (stitch_v55_optimized.json)
a été écrit le 2026-08-25 alors que ses données vont jusqu'à 2026-05 : un simple
split 80/20 « test récent » recoupe donc l'ensemble d'entraînement du modèle
déployé -> accuracy IN-SAMPLE (~best_score 0.8416 = logloss mesurée 0.8427).

Ici on ne touche à AUCUN modèle de prod : on réentraîne un XGB neuf par pli
chronologique (expanding window), en n'utilisant QUE le passé pour chaque test,
et on agrège les prédictions OOS. Paramètres repris du booster déployé
(save_config) : eta=0.3, max_depth=6, subsample=1, colsample_bytree=1,
reg_lambda=1, reg_alpha=0, min_child_weight=1, gamma=0.

Usage :
  python scripts/eval_v55_walkforward_retrain.py
Env :
  LIMIT (défaut 15000), FOLDS (défaut 5), ROUNDS (défaut 300)
"""
import os
import sys
import json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE = os.path.join(ROOT, "core")
if CORE not in sys.path:
    sys.path.insert(0, CORE)

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import xgboost as xgb  # noqa: E402
from sklearn.metrics import log_loss  # noqa: E402
from sklearn.utils.class_weight import compute_sample_weight  # noqa: E402
from sklearn.model_selection import TimeSeriesSplit  # noqa: E402

from train_v55 import load_data  # noqa: E402
from ml_features import FEATURE_NAMES_V55, CLOSING_DERIVED_FEATURES  # noqa: E402

MODEL_PATH = os.path.join(ROOT, "models", "stitch_v55_optimized.json")
REPORT_PATH = os.path.join(ROOT, "data", "v55_walkforward_retrain_report.json")

# Paramètres du booster déployé (extraits via save_config de stitch_v55_optimized.json).
DEPLOYED_PARAMS = {
    "objective": "multi:softprob",
    "num_class": 3,
    "eval_metric": "mlogloss",
    "tree_method": "hist",
    "nthread": -1,
    "verbosity": 0,
    "learning_rate": 0.3,
    "max_depth": 6,
    "subsample": 1.0,
    "colsample_bytree": 1.0,
    "min_child_weight": 1,
    "gamma": 0.0,
    "reg_alpha": 0.0,
    "reg_lambda": 1.0,
}


def brier_score(proba, y_true):
    oh = np.zeros_like(proba)
    oh[np.arange(len(y_true)), y_true] = 1.0
    return float(((proba - oh) ** 2).sum(axis=1).mean())


def ece_score(proba, y_true, n_bins=10):
    conf = proba.max(axis=1)
    pred = proba.argmax(axis=1)
    bins = np.linspace(0.0, 1.0, n_bins + 1)
    ece = 0.0
    total = len(y_true)
    for i in range(n_bins):
        lo, hi = bins[i], bins[i + 1]
        m = (conf >= lo) & (conf <= hi) if i == n_bins - 1 else (conf >= lo) & (conf < hi)
        cnt = int(m.sum())
        if cnt == 0:
            continue
        acc = float((pred[m] == y_true[m]).mean())
        avg = float(conf[m].mean())
        ece += abs(acc - avg) * (cnt / total)
    return ece


def strength(y_true, proba):
    y_true = np.asarray(y_true)
    proba = np.asarray(proba)
    proba = proba / proba.sum(axis=1, keepdims=True)
    pred = proba.argmax(axis=1)
    acc = float((pred == y_true).mean())
    ll = float(log_loss(y_true, proba, labels=[0, 1, 2]))
    br = brier_score(proba, y_true)
    ece = ece_score(proba, y_true)
    rec = {}
    for c, name in [(0, "H"), (1, "D"), (2, "A")]:
        m = y_true == c
        rec[name] = float((pred[m] == c).mean()) if m.sum() else 0.0
    return {"n": int(len(y_true)), "acc": acc, "logloss": ll, "brier": br, "ece": ece, "recall": rec}


def predict_deployed(X):
    booster = xgb.Booster()
    booster.load_model(MODEL_PATH)
    fn = [f for f in FEATURE_NAMES_V55 if f in X.columns]
    Xs = X[fn].astype(float)
    for c in CLOSING_DERIVED_FEATURES:
        if c in Xs.columns:
            Xs[c] = 0.0
    return booster.predict(xgb.DMatrix(Xs.values, feature_names=fn))


def main():
    os.chdir(ROOT)
    limit = int(os.environ.get("LIMIT", "15000"))
    folds = int(os.environ.get("FOLDS", "5"))
    rounds = int(os.environ.get("ROUNDS", "300"))

    print("[WF] load_data(limit=%d) ..." % limit)
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
    print("[WF] rows=%d features=%d  %s .. %s" % (n, X.shape[1], dts[0], dts[-1]))
    print("[WF] class dist H/D/A = %d/%d/%d" % ((y == 0).sum(), (y == 1).sum(), (y == 2).sum()))

    Xnp = X.astype(float).values

    # (A) Modèle déployé, évalué sur TOUT (IN-SAMPLE : il a probablement vu ces lignes)
    dep = predict_deployed(X)
    in_sample = strength(y, dep)
    print("[WF] DÉPLOYÉ in-sample  acc=%.4f logloss=%.4f brier=%.4f" %
          (in_sample["acc"], in_sample["logloss"], in_sample["brier"]))

    # (B) Walk-forward AVEC réentraînement : expanding window, test = bloc suivant
    tscv = TimeSeriesSplit(n_splits=folds)
    oos_pred = np.full((n, 3), np.nan)
    fold_reports = []
    for k, (tr, te) in enumerate(tscv.split(Xnp)):
        # tail chronologique du train pour l'early-stopping (pas de fuite)
        cut = max(1, int(len(tr) * 0.88))
        core, ev = tr[:cut], tr[cut:]
        if len(ev) < 20:
            core, ev = tr, tr[-20:]
        cw = compute_sample_weight(class_weight="balanced", y=y[core])
        cw = cw / cw.mean()
        dtr = xgb.DMatrix(Xnp[core], label=y[core], weight=cw)
        dev = xgb.DMatrix(Xnp[ev], label=y[ev])
        dte = xgb.DMatrix(Xnp[te])
        params = dict(DEPLOYED_PARAMS)
        model = xgb.train(
            params, dtr, num_boost_round=rounds,
            evals=[(dev, "validation_0")],
            callbacks=[xgb.callback.EarlyStopping(rounds=50, metric_name="mlogloss",
                                                  data_name="validation_0", save_best=True)],
            verbose_eval=False,
        )
        p = model.predict(dte)
        oos_pred[te] = p
        fr = strength(y[te], p)
        fr["fold"] = k
        fr["train_n"] = int(len(tr))
        fr["test_period"] = "%s .. %s" % (str(dts[te][0])[:10], str(dts[te][-1])[:10])
        fold_reports.append(fr)
        print("[WF] pli %d  train=%5d test=%4d (%s)  acc=%.4f logloss=%.4f" %
              (k, len(tr), len(te), fr["test_period"], fr["acc"], fr["logloss"]))

    mask = ~np.isnan(oos_pred[:, 0])
    pooled = strength(y[mask], oos_pred[mask])
    print("[WF] WALK-FORWARD OOS poolé  n=%d acc=%.4f logloss=%.4f brier=%.4f ece=%.4f" %
          (pooled["n"], pooled["acc"], pooled["logloss"], pooled["brier"], pooled["ece"]))
    print("[WF]   recall H/D/A = %.3f/%.3f/%.3f" %
          (pooled["recall"]["H"], pooled["recall"]["D"], pooled["recall"]["A"]))

    # Baselines OOS ; prior = classe majoritaire apprise sur le train du 1er pli complet
    always_home = float((y[mask] == 0).mean())
    print("[WF] baselines OOS : toujours-domicile=%.4f prior-classe-max=%.4f" %
          (always_home, max((y[mask] == c).mean() for c in (0, 1, 2))))

    report = {
        "config": {"limit": limit, "folds": folds, "rounds": rounds,
                   "params": DEPLOYED_PARAMS, "source": "master history via load_data"},
        "deployed_in_sample": in_sample,
        "walkforward_pooled_oos": pooled,
        "folds": fold_reports,
        "baselines_oos": {
            "always_home": always_home,
            "prior_class_max": float(max((y[mask] == c).mean() for c in (0, 1, 2))),
        },
    }
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, default=str)
    print("[WF] rapport -> %s" % REPORT_PATH)


if __name__ == "__main__":
    main()
