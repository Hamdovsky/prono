# -*- coding: utf-8 -*-
"""E100 — Réentraînement « honnête » de V55 (NON destructif).

Contexte : E97 a corrigé le bug de timestamp qui vidait l'historique équipe à
l'entraînement ; E99 a montré que l'accuracy ~59-60 % du modèle déployé était
gonflée par une fuite (~53,6 % en walk-forward honnête, ~56,7 % sur la période
récente). Ici on produit un modèle PROPRE :

  1) Holdout chronologique FUTUR : train/val = tout sauf les 15 % les plus récents,
     test = ces 15 % (jamais vus). Deux configs candidates sont comparées sur la
     val (early-stopping), la meilleure est retenue et son score TEST est le vrai OOS.
  2) Refit sur TOUTES les données (train+test) avec le nombre d'itérations optimal
     → c'est CE booster qui est sauvegardé, dans un fichier CANDIDAT.

Le modèle de production `models/stitch_v55_optimized.json` n'est PAS touché.
Promotion = copier le candidat vers le chemin de prod (décision explicite).

Usage :
  python scripts/train_v55_honest.py
Env :
  LIMIT (défaut 30000), TEST_FRAC (défaut 0.15), VAL_FRAC (défaut 0.12), OUT
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

MODEL_PATH = os.path.join(ROOT, "models", "stitch_v55_optimized.json")
CANDIDATE_PATH = os.path.join(ROOT, "models", "stitch_v55_candidate.json")
REPORT_PATH = os.path.join(ROOT, "data", "v55_honest_retrain_report.json")

BASE_PARAMS = {
    "objective": "multi:softprob",
    "num_class": 3,
    "eval_metric": "mlogloss",
    "tree_method": "hist",
    "nthread": -1,
    "verbosity": 0,
}

CONFIGS = {
    # Reproduit le booster déployé (save_config)
    "deployed": {"learning_rate": 0.3, "max_depth": 6, "subsample": 1.0,
                 "colsample_bytree": 1.0, "min_child_weight": 1,
                 "gamma": 0.0, "reg_alpha": 0.0, "reg_lambda": 1.0},
    # Régime plus doux (n_estimators plus grand, early-stopping)
    "gentle": {"learning_rate": 0.05, "max_depth": 6, "subsample": 0.8,
               "colsample_bytree": 0.8, "min_child_weight": 1,
               "gamma": 0.0, "reg_alpha": 0.0, "reg_lambda": 1.0},
}


def train_xgb(Xtr, ytr, Xev, yev, params, rounds):
    cw = compute_sample_weight(class_weight="balanced", y=ytr)
    cw = cw / cw.mean()
    dtr = xgb.DMatrix(Xtr, label=ytr, weight=cw)
    dev = xgb.DMatrix(Xev, label=yev)
    model = xgb.train(
        dict(BASE_PARAMS, **params), dtr, num_boost_round=rounds,
        evals=[(dev, "validation_0")],
        callbacks=[xgb.callback.EarlyStopping(rounds=50, metric_name="mlogloss",
                                              data_name="validation_0", save_best=True)],
        verbose_eval=False,
    )
    best = model.best_iteration if model.best_iteration is not None else rounds
    return model, best


def main():
    os.chdir(ROOT)
    limit = int(os.environ.get("LIMIT", "30000"))
    test_frac = float(os.environ.get("TEST_FRAC", "0.15"))
    val_frac = float(os.environ.get("VAL_FRAC", "0.12"))
    out_path = os.environ.get("OUT", CANDIDATE_PATH)

    print("[H] load_data(limit=%d) ..." % limit)
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
    print("[H] rows=%d features=%d  %s .. %s" % (n, X.shape[1], dts[0], dts[-1]))

    n_test = int(n * test_frac)
    n_train_all = n - n_test
    tr_all = np.arange(n_train_all)
    te = np.arange(n_train_all, n)
    n_val = max(50, int(n_train_all * val_frac))
    core, val = tr_all[:-n_val], tr_all[-n_val:]
    print("[H] core=%d val=%d test=%d  test=%s .. %s" % (
        len(core), len(val), len(te), str(dts[te][0])[:10], str(dts[te][-1])[:10]))

    results = {}
    for name, params in CONFIGS.items():
        rounds = 800 if name == "gentle" else 400
        model, best = train_xgb(Xnp[core], y[core], Xnp[val], y[val], params, rounds)
        p_val = model.predict(xgb.DMatrix(Xnp[val]))
        p_te = model.predict(xgb.DMatrix(Xnp[te]))
        mv = strength(y[val], p_val)
        mt = strength(y[te], p_te)
        results[name] = {"best_iteration": int(best), "val": mv, "test": mt}
        print("[H] config=%-8s best_iter=%3d | VAL acc=%.4f ll=%.4f | TEST acc=%.4f ll=%.4f brier=%.4f" %
              (name, best, mv["acc"], mv["logloss"], mt["acc"], mt["logloss"], mt["brier"]))

    winner = min(CONFIGS.keys(), key=lambda k: results[k]["val"]["logloss"])
    wtest = results[winner]["test"]
    print("[H] VAINQUEUR (val logloss) = %s -> TEST (OOS honnête) acc=%.4f logloss=%.4f brier=%.4f ece=%.4f" %
          (winner, wtest["acc"], wtest["logloss"], wtest["brier"], wtest["ece"]))

    always_home = float((y[te] == 0).mean())
    prior = float(max((y[te] == c).mean() for c in (0, 1, 2)))
    print("[H] baselines test : toujours-domicile=%.4f prior=%.4f" % (always_home, prior))

    # Refit sur TOUT (train+test) avec le nombre d'itérations optimal du vainqueur.
    best_it = results[winner]["best_iteration"]
    refit_rounds = int(best_it * 1.1) + 1
    cw = compute_sample_weight(class_weight="balanced", y=y)
    cw = cw / cw.mean()
    dall = xgb.DMatrix(Xnp, label=y, weight=cw)
    final = xgb.train(dict(BASE_PARAMS, **CONFIGS[winner]), dall, num_boost_round=refit_rounds,
                      verbose_eval=False)
    final.save_model(out_path)
    print("[H] modèle final (refit %d rounds sur %d lignes) -> %s" % (refit_rounds, n, out_path))

    report = {
        "config": {"limit": limit, "test_frac": test_frac, "val_frac": val_frac,
                   "n": n, "n_core": len(core), "n_val": len(val), "n_test": len(te),
                   "test_period": [str(dts[te][0])[:10], str(dts[te][-1])[:10]]},
        "candidates": results,
        "winner": winner,
        "honest_test": wtest,
        "baselines_test": {"always_home": always_home, "prior_class_max": prior},
        "candidate_path": out_path,
        "refit_rounds": refit_rounds,
    }
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, default=str)
    print("[H] rapport -> %s" % REPORT_PATH)


if __name__ == "__main__":
    main()
