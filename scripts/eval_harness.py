"""
eval_harness.py — Harnais d'évaluation offline, reproductible, SANS Postgres ni réseau.

But (P0 de l'audit E96) : fournir UNE mesure fiable de l'accuracy 1X2 / OU2.5 / BTTS
en walk-forward chronologique, sur `master.db :: master_matches` (18478 matchs, features
xG incluses), afin de trancher entre les modèles concurrents et d'isoler l'apport des
features xG (BASE vs FULL).

- Aucun accès PG : lecture SQLite locale uniquement.
- Fenêtre strictement chronologique (expanding + embargo), pas de fuite temporelle.
- Baseline marché (cotes d'ouverture dé-vigées) servie comme référence à battre.
- Modèles : régression logistique (rapide, référence) et, si dispo, XGBoost.

Usage :
    python scripts/eval_harness.py --market 1x2
    python scripts/eval_harness.py --market ou25 --model xgb
    python scripts/eval_harness.py --market 1x2 --compare-features
"""
import argparse
import json
import math
import os
import sqlite3
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

MASTER_DB = os.path.join(ROOT, "data_pipeline", "data", "processed", "master.db")

BASE_FEATS = [
    "elo_home", "elo_away", "F_Elo_Diff",
    "H_gf_L5", "H_ga_L5", "A_gf_L5", "A_ga_L5",
    "H_pts_L5", "A_pts_L5", "H_shots_L5", "A_shots_L5",
]
XG_FEATS = [
    "H_xg_L5", "H_xga_L5", "A_xg_L5", "A_xga_L5",
    "Total_xG_L5", "Form_Diff_L5",
]
ODDS_FEATS = ["odds_h_avg", "odds_d_avg", "odds_a_avg"]
OU_ODDS_FEATS = ["odds_o25_avg", "odds_u25_avg"]

MARKETS = {
    "1x2": {"classes": 3},
    "ou25": {"classes": 2},
    "btts": {"classes": 2},
}


def load_master():
    con = sqlite3.connect(MASTER_DB)
    df = pd.read_sql_query("SELECT * FROM master_matches", con)
    con.close()
    df = df[df["ftr"].notna()].copy()
    df["_date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df[df["_date"].notna()].sort_values("_date").reset_index(drop=True)
    return df


def label_for(df, market):
    if market == "1x2":
        y = df["ftr"].map({"H": 0, "D": 1, "A": 2})
        return y.astype(int).values
    if market == "ou25":
        return ((df["fthg"] + df["ftag"]) > 2.5).astype(int).values
    if market == "btts":
        return ((df["fthg"] > 0) & (df["ftag"] > 0)).astype(int).values
    raise ValueError(market)


def devig_1x2(df):
    oh = pd.to_numeric(df["odds_h_avg"], errors="coerce")
    od = pd.to_numeric(df["odds_d_avg"], errors="coerce")
    oa = pd.to_numeric(df["odds_a_avg"], errors="coerce")
    inv = np.vstack([1.0 / oh, 1.0 / od, 1.0 / oa]).T
    s = inv.sum(axis=1, keepdims=True)
    return inv / s


def devig_binary(o_over, o_under):
    oo = pd.to_numeric(o_over, errors="coerce")
    ou = pd.to_numeric(o_under, errors="coerce")
    a = 1.0 / oo
    b = 1.0 / ou
    s = a + b
    return (a / s).values


def metrics(proba, y):
    proba = np.asarray(proba, dtype=float)
    y = np.asarray(y)
    n = len(y)
    pred = proba.argmax(axis=1)
    acc = float((pred == y).mean())
    onehot = np.zeros_like(proba)
    onehot[np.arange(n), y] = 1.0
    ll = float(-np.log(np.clip(proba[np.arange(n), y], 1e-9, 1)).mean())
    brier = float(((proba - onehot) ** 2).sum(axis=1).mean())
    conf = proba.max(axis=1)
    bins = np.linspace(0, 1, 11)
    ece = 0.0
    for i in range(10):
        lo, hi = bins[i], bins[i + 1]
        m = (conf >= lo) & (conf <= hi) if i == 9 else (conf >= lo) & (conf < hi)
        if m.sum() == 0:
            continue
        ece += abs((pred[m] == y[m]).mean() - conf[m].mean()) * (m.sum() / n)
    return {"n": n, "acc": acc, "logloss": ll, "brier": brier, "ece": float(ece)}


def walk_forward(df, y, feats, model_name, folds, embargo):
    X = df[feats].apply(pd.to_numeric, errors="coerce")
    n = len(df)
    all_pred = np.full((n, int(y.max()) + 1), np.nan)
    bounds = [int(round(n * k / (folds + 1))) for k in range(folds + 2)]

    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler

    for k in range(1, folds + 1):
        tr_end = max(0, bounds[k] - embargo)
        te_start, te_end = bounds[k], bounds[k + 1]
        if tr_end < 50 or te_end <= te_start:
            continue
        Xtr = X.iloc[:tr_end]
        ytr = y[:tr_end]
        Xte = X.iloc[te_start:te_end]
        med = Xtr.median()
        Xtr = Xtr.fillna(med).fillna(0.0).values
        Xte = Xte.fillna(med).fillna(0.0).values
        if model_name == "lr":
            sc = StandardScaler().fit(Xtr)
            clf = LogisticRegression(max_iter=2000, C=1.0)
            clf.fit(sc.transform(Xtr), ytr)
            p = clf.predict_proba(sc.transform(Xte))
        elif model_name == "xgb":
            import xgboost as xgb
            clf = xgb.XGBClassifier(
                objective="multi:softprob" if len(set(y)) > 2 else "binary:logistic",
                num_class=3 if len(set(y)) > 2 else None,
                max_depth=3, learning_rate=0.03, n_estimators=400,
                subsample=0.85, colsample_bytree=0.7, min_child_weight=30,
                reg_lambda=2.0, reg_alpha=0.5, tree_method="hist",
                eval_metric="mlogloss", n_jobs=2, verbosity=0,
            )
            clf.fit(Xtr, ytr)
            p = clf.predict_proba(Xte)
        else:
            raise ValueError(model_name)
        all_pred[te_start:te_end, :p.shape[1]] = p

    mask = ~np.isnan(all_pred[:, 0])
    return all_pred[mask], y[mask]


def baseline_market(df, y, market):
    if market == "1x2":
        p = devig_1x2(df)
    elif market == "ou25":
        p = np.vstack([devig_binary(df["odds_o25_avg"], df["odds_u25_avg"]),
                       1 - devig_binary(df["odds_o25_avg"], df["odds_u25_avg"])]).T
    else:
        return None
    mask = ~np.isnan(p).any(axis=1)
    return p[mask], y[mask]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", default="1x2", choices=list(MARKETS))
    ap.add_argument("--model", default="lr", choices=["lr", "xgb"])
    ap.add_argument("--folds", type=int, default=6)
    ap.add_argument("--embargo", type=int, default=14)
    ap.add_argument("--compare-features", action="store_true",
                    help="Comparer BASE (sans xG) vs FULL (avec xG) vs ODDS (marché)")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    df = load_master()
    y = label_for(df, args.market)
    print("[harness] market=%s rows=%d leagues=%d span=%s..%s" % (
        args.market, len(df), df["league"].nunique(),
        str(df["_date"].min().date()), str(df["_date"].max().date())))

    results = {}

    n_classes = int(y.max()) + 1
    priors = np.bincount(y, minlength=n_classes) / len(y)
    prior_proba = np.tile(priors, (len(y), 1))
    results["baseline_prior"] = metrics(prior_proba, y)

    if args.market == "1x2":
        bm = baseline_market(df, y, args.market)
        if bm is not None:
            results["baseline_market_devig"] = metrics(bm[0], bm[1])
    elif args.market == "ou25":
        p_over = devig_binary(df["odds_o25_avg"], df["odds_u25_avg"])
        p = np.vstack([1 - p_over, p_over]).T
        mask = ~np.isnan(p).any(axis=1)
        results["baseline_market_devig"] = metrics(p[mask], y[mask])

    print("\n=== baselines ===")
    for name, m in results.items():
        print("  %-22s n=%5d  acc=%.4f  logloss=%.4f  brier=%.4f  ece=%.4f" % (
            name, m["n"], m["acc"], m["logloss"], m["brier"], m["ece"]))

    feat_sets = {
        "BASE": BASE_FEATS,
        "BASE+ODDS": BASE_FEATS + ODDS_FEATS,
        "FULL(xG)": BASE_FEATS + XG_FEATS,
        "FULL(xG)+ODDS": BASE_FEATS + XG_FEATS + ODDS_FEATS,
    }
    print("\n=== %s — walk-forward (folds=%d, embargo=%d, model=%s) ===" % (
        args.market, args.folds, args.embargo, args.model))
    for name, feats in feat_sets.items():
        p, yy = walk_forward(df, y, feats, args.model, args.folds, args.embargo)
        m = metrics(p, yy)
        results[name] = m
        print("  %-18s n=%5d  acc=%.4f  logloss=%.4f  brier=%.4f  ece=%.4f" % (
            name, m["n"], m["acc"], m["logloss"], m["brier"], m["ece"]))

    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=2)
        print("[harness] results -> %s" % args.json)


if __name__ == "__main__":
    main()
