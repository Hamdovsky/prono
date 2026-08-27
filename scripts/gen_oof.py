"""
Phase 1 (bis) : predictions OOF avec membres SPECIALISES par vecteur de features
disjoint, pour briser la forte correlation H des membres standards.

Membres standards (allowlist master) : lr, rf, xgb, promo(xgb depth6), dc, poisson.
Membres specialises (vecteur restreint, diversite) :
  - elo_xgb   : Elo seulement      -> biais favori-Elo
  - xg_xgb    : xG/formes seulement -> biais favori-xG
  - close_xgb : cotes de cloture    -> biais marche

Chaque membre est (re)entraine par fold walk-forward (expanding window + embargo 7j).
Sortie : data_pipeline/data/processed/oof_1x2.csv (tous les membres, alignes par match).

Usage :
  data_pipeline/.venv/Scripts/python.exe scripts/gen_oof.py
"""
from __future__ import annotations
import sys
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "data_pipeline"))
import os as _os
import config as _cfg  # noqa: E402
import core.backtest_walkforward as _bw  # noqa: E402
_over = _os.environ.get("MASTER_CSV_OVERRIDE")
if _over:
    _p = Path(_over)
    _cfg.MASTER_CSV = _p
    _bw.MASTER_CSV = _p
    print(f"[override] MASTER_CSV -> {_p}")
_vs = _os.environ.get("VAL_SEASON_OVERRIDE")
if _vs:
    _bw.VAL_SEASON = int(_vs)
    print(f"[override] VAL_SEASON -> {_bw.VAL_SEASON}")
from core.backtest_walkforward import (
    build_targets, load_master, leakage_tripwire, _make_models, month_folds,
    FEATURE_ALLOWLIST, dixon_coles_params, dixon_coles_predict,
    poisson_params, poisson_predict,
)

OUT = ROOT / "data_pipeline" / "data" / "processed" / "oof_1x2.csv"
MARKET = "1x2"
YCOL = "y_1x2"

# Vecteurs de features disjoints (tous presents dans master_dataset.csv)
ELO_FEATS = ["elo_home", "elo_away", "F_Elo_Diff"]
XG_FEATS = ["home_xg", "away_xg", "home_xa", "away_xa",
            "H_xg_L5", "H_xg_L10", "H_xga_L5", "H_xga_L10",
            "H_xa_L5", "H_xa_L10", "A_xg_L5", "A_xg_L10",
            "A_xga_L5", "A_xga_L10", "A_xa_L5", "A_xa_L10",
            "Total_xG_L5", "Form_Diff_L5"]
CLOSE_FEATS = ["P1_close_avg", "PX_close_avg", "P2_close_avg",
               "odds_h_close_avg", "odds_d_close_avg", "odds_a_close_avg",
               "odds_o25_close_avg", "odds_u25_close_avg",
               "F_OddsH_Close_Diff", "F_O25_Close_Diff"]

# Membres : nom -> ("ALLOWLIST" ou liste de features)
MEMBER_FEATS = {
    "lr": "ALLOWLIST", "rf": "ALLOWLIST", "xgb": "ALLOWLIST", "promo": "ALLOWLIST",
    "elo_xgb": ELO_FEATS, "xg_xgb": XG_FEATS, "close_xgb": CLOSE_FEATS,
}


def xgb_promo_factory():
    from xgboost import XGBClassifier
    return XGBClassifier(n_estimators=200, max_depth=6, learning_rate=0.1,
                         subsample=0.85, colsample_bytree=0.8, min_child_weight=10,
                         random_state=42, n_jobs=-1, eval_metric="mlogloss",
                         objective="multi:softprob", num_class=3, tree_method="hist")


def make_factory(name, factories):
    if name == "promo":
        return xgb_promo_factory
    if name in factories:
        return lambda: factories[name](3)
    return lambda: factories["xgb"](3)  # membres spécialisés = XGB sur vecteur restreint


def predict_proba(clf, Xva, n_classes):
    raw = clf.predict_proba(Xva)
    proba = np.zeros((len(Xva), n_classes))
    for j, c in enumerate(clf.classes_):
        if c < n_classes:
            proba[:, c] = raw[:, j]
    renorm = proba.sum(axis=1, keepdims=True)
    renorm[renorm == 0] = 1
    return proba / renorm


def main():
    df = build_targets(load_master())
    sub = df.dropna(subset=[YCOL]).reset_index(drop=True)
    n = len(sub)
    y = sub[YCOL].astype(int).to_numpy()
    league = sub["league"].to_numpy()
    print(f"[gen_oof] 1x2 : n={n}")

    factories = _make_models()
    out = {m: np.zeros((n, 3)) for m in MEMBER_FEATS}
    out["dc"] = np.zeros((n, 3))
    out["poisson"] = np.zeros((n, 3))
    fold_of = np.array([""] * n, dtype=object)

    for fold in month_folds(sub):
        train, v = fold["train"], fold["val"]
        vidx = v.index.to_numpy()
        fold_of[vidx] = fold["fold"]

        for m, spec in MEMBER_FEATS.items():
            base = [f for f in (FEATURE_ALLOWLIST if spec == "ALLOWLIST" else spec)
                    if f in train.columns and f in v.columns]
            if len(base) < 2:
                continue
            fk = leakage_tripwire(train, base, MARKET)
            med = train[fk].median()
            Xtr = train[fk].apply(lambda c: c.astype(float).fillna(med))
            Xva = v[fk].apply(lambda c: c.astype(float).fillna(med))
            clf = make_factory(m, factories)()
            clf.fit(Xtr, train[YCOL].astype(int))
            out[m][vidx] = predict_proba(clf, Xva, 3)

        dc_p = dixon_coles_params(train)
        out["dc"][vidx] = dixon_coles_predict(dc_p, v, MARKET)
        po_p = poisson_params(
            train[["league", "home_team", "away_team", "fthg", "ftag"]].dropna(subset=["fthg", "ftag"])
        )
        out["poisson"][vidx] = poisson_predict(po_p, v, MARKET)

    rows = {"y_true": y, "league": league, "fold": fold_of}
    for m in list(MEMBER_FEATS) + ["dc", "poisson"]:
        for k, col in enumerate(["H", "D", "A"]):
            rows[f"p_{m}_{col}"] = out[m][:, k]
    oof = pd.DataFrame(rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    oof.to_csv(OUT, index=False)
    print(f"[gen_oof] sauvegarde -> {OUT} ({len(oof)} lignes, {len(MEMBER_FEATS)+2} membres)")

    for m in list(MEMBER_FEATS) + ["dc", "poisson"]:
        pm = oof[[f"p_{m}_H", f"p_{m}_D", f"p_{m}_A"]].to_numpy()
        arg = pm.argmax(axis=1)
        dist = {c: int((arg == i).sum()) for i, c in enumerate("HDA")}
        top = max(dist, key=dist.get)
        print(f"  {m:8s} argmax={dist} maj={top} {100*dist[top]/len(arg):.1f}%")


if __name__ == "__main__":
    main()
