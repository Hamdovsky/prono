"""Tuning hyperparamètres XGBoost (walk-forward, sans fuite) — audit "continue XGB".

Réutilise le harnais core/backtest_walkforward.py (month_folds, load_master,
leakage_tripwire, FEATURE_ALLOWLIST, metrics_*) pour évaluer plusieurs jeux
d'hyperparamètres XGB en walk-forward mensuel sur la saison VAL_SEASON, et
compare à la référence LR (référence prod = ~60,27% 1X2).

Objectif honnête : voir si un tuning HP CIBLÉ (et non juste +features) permet à
XGB de dépasser LR sur 1X2 / OU25 / BTTS. Aucune modification de modèle en prod
sauf décision explicite (et seulement si un jeu bat la référence).

Usage :
    python -m scripts.tune_xgb_hp            (grille par défaut)
    python -m scripts.tune_xgb_hp --quick    (3 jeux seulement, pour smoke-test)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core"))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from xgboost import XGBClassifier  # noqa: E402

import backtest_walkforward as bw  # noqa: E402


# Grille d'hyperparamètres : profondeur / régularisation ciblées (L2 + min_child).
# On évite le surapprentissage collinearisé noté dans l'audit (XGB "dernier").
XGB_GRID = [
    # nom,                    params
    ("base", dict(max_depth=4, learning_rate=0.05, n_estimators=300,
                  subsample=0.9, colsample_bytree=0.8, min_child_weight=20,
                  reg_lambda=1.0, reg_alpha=0.0)),
    ("shallow", dict(max_depth=3, learning_rate=0.03, n_estimators=400,
                     subsample=0.85, colsample_bytree=0.7, min_child_weight=30,
                     reg_lambda=2.0, reg_alpha=0.5)),
    ("deep_reg", dict(max_depth=6, learning_rate=0.02, n_estimators=500,
                      subsample=0.8, colsample_bytree=0.6, min_child_weight=50,
                      reg_lambda=5.0, reg_alpha=1.0)),
    ("wide_reg", dict(max_depth=4, learning_rate=0.05, n_estimators=300,
                      subsample=1.0, colsample_bytree=1.0, min_child_weight=80,
                      reg_lambda=10.0, reg_alpha=2.0)),
    ("minchild", dict(max_depth=5, learning_rate=0.04, n_estimators=350,
                      subsample=0.9, colsample_bytree=0.8, min_child_weight=120,
                      reg_lambda=3.0, reg_alpha=0.0)),
    ("lr_high", dict(max_depth=4, learning_rate=0.10, n_estimators=200,
                     subsample=0.9, colsample_bytree=0.8, min_child_weight=25,
                     reg_lambda=1.5, reg_alpha=0.0)),
]

QUICK = ["base", "shallow", "deep_reg"]


def _xgb(n_classes: int, params: dict):
    p = dict(params)
    p.update(dict(random_state=42, n_jobs=-1, tree_method="hist",
                  eval_metric="mlogloss" if n_classes > 2 else "logloss"))
    if n_classes > 2:
        p["objective"] = "multi:softprob"
        p["num_class"] = n_classes
    else:
        p["objective"] = "binary:logistic"
    return XGBClassifier(**p)


def eval_xgb(market: str, params: dict, df: pd.DataFrame) -> dict:
    ycol = f"y_{market}"
    sub = df.dropna(subset=[ycol])
    binary = market in ("ou25", "btts")
    raws, ys = [], []
    for fold in bw.month_folds(sub):
        train, v = fold["train"], fold["val"]
        available = [f for f in bw.FEATURE_ALLOWLIST if f in train.columns and f in v.columns]
        if len(available) < 3:
            continue
        feats = bw.leakage_tripwire(train, available, market)
        clf = _xgb(2 if binary else 3, params)
        clf.fit(train[feats], train[ycol].astype(int))
        raws.append(clf.predict_proba(v[feats]))
        ys.append(v[ycol].astype(int).to_numpy())
    if not raws:
        return {"total_n": 0, "folds": 0, "logloss": None, "acc": None}
    raw = np.vstack(raws)
    y_all = np.concatenate(ys)
    if binary:
        m = bw.metrics_binary(y_all, raw[:, 1])
    else:
        m = bw.metrics_multi(y_all, raw)
    return {"total_n": m["n"], "folds": len(raws),
            "logloss": m["logloss"], "acc": m["acc"]}


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Tuning HP XGBoost walk-forward")
    ap.add_argument("--quick", action="store_true", help="3 jeux uniquement (smoke-test)")
    ap.add_argument("--markets", default="1x2,ou25,btts")
    args = ap.parse_args(argv)

    markets = [m.strip() for m in args.markets.split(",") if m.strip()]
    names = QUICK if args.quick else [g[0] for g in XGB_GRID]
    grid = {g[0]: g[1] for g in XGB_GRID if (g[0] in names)}

    print(f"[TUNE XGB] marchés={markets} | jeux={list(grid)} | embargo={bw.EMBARGO_DAYS}j")
    df = bw.build_targets(bw.load_master())

    # Référence LR/RF pour comparaison (harnais canonical).
    ref = {}
    for market in markets:
        ycol = f"y_{market}"
        sub = df.dropna(subset=[ycol])
        binary = market in ("ou25", "btts")
        model_name = "lr" if market != "btts" else "rf"
        fac = bw._make_models().get(model_name)
        raws, ys = [], []
        for fold in bw.month_folds(sub):
            train, v = fold["train"], fold["val"]
            available = [f for f in bw.FEATURE_ALLOWLIST if f in train.columns and f in v.columns]
            if len(available) < 3:
                continue
            feats = bw.leakage_tripwire(train, available, market)
            clf = fac(2 if binary else 3)
            clf.fit(train[feats], train[ycol].astype(int))
            raws.append(clf.predict_proba(v[feats]))
            ys.append(v[ycol].astype(int).to_numpy())
        if not raws:
            continue
        raw = np.vstack(raws)
        y_all = np.concatenate(ys)
        m = (bw.metrics_binary(y_all, raw[:, 1]) if binary else bw.metrics_multi(y_all, raw))
        ref[market] = {"acc": m["acc"], "logloss": m["logloss"]}

    results = {}
    for name, params in grid.items():
        results[name] = {}
        for market in markets:
            r = eval_xgb(market, params, df)
            results[name][market] = r
            rref = ref.get(market, {})
            beat = (r["acc"] is not None and rref.get("acc") is not None
                    and r["acc"] > rref["acc"])
            print(f"  [{name:>10}] {market:>4}: acc={r['acc']} vs LR/RF {rref.get('acc')}"
                  f" {'  <== BAT REF' if beat else ''}")

    print("\n=== Référence (LR 1X2/OU25, RF BTTS) ===")
    for market, r in ref.items():
        print(f"  {market:>4}: acc={r['acc']} logloss={r['logloss']}")

    # Meilleur jeu par marché (accuracy max).
    best_by_market = {}
    for market in markets:
        best_name, best_acc = None, -1
        for name in grid:
            a = results[name][market]["acc"]
            if a is not None and a > best_acc:
                best_acc, best_name = a, name
        best_by_market[market] = {"config": best_name, "acc": best_acc,
                                   "params": grid.get(best_name)}

    out = {
        "xgb_grid_results": results,
        "reference_lr_rf": ref,
        "best_xgb_by_market": best_by_market,
        "beats_reference": {
            m: (best_by_market[m]["acc"] is not None
                and ref.get(m, {}).get("acc") is not None
                and best_by_market[m]["acc"] > ref[m]["acc"])
            for m in markets
        },
    }
    out_path = ROOT / "data_pipeline" / "data" / "processed" / "xgb_tuning.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"\n[Résultat] écrit -> {out_path}")
    print("Batts référence ?", out["beats_reference"])


if __name__ == "__main__":
    main()
