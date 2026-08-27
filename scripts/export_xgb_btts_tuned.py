"""Exporte models/xgb_btts_tuned.pkl — XGB BTTS optimisé (deep_reg) issu du tuning.

Artefact NON-intrusif : ne modifie AUCUN modele en prod, n'est pas branche dans
le chemin de prediction. Sert de membre d'ensemble leger futur optionnel (pour
remplacer RF sur BTTS si validation OOF confirmee). Entraine sur tout le master
riche local (Top-5), allowlist causale, sans fuite (colonnes cibles/closing/
stats in-match exclues).
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core"))

import joblib  # noqa: E402
import numpy as np  # noqa: E402

import backtest_walkforward as bw  # noqa: E402

BTTS_PARAMS = dict(
    max_depth=6, learning_rate=0.02, n_estimators=500,
    subsample=0.8, colsample_bytree=0.6, min_child_weight=50,
    reg_lambda=5.0, reg_alpha=1.0, random_state=42, n_jobs=-1,
    tree_method="hist", objective="binary:logistic", eval_metric="logloss",
)


def main() -> None:
    df = bw.build_targets(bw.load_master())
    market = "btts"
    ycol = "y_btts"
    sub = df.dropna(subset=[ycol])
    available = [f for f in bw.FEATURE_ALLOWLIST if f in sub.columns]
    feats = bw.leakage_tripwire(sub, available, market)
    X = sub[feats].apply(lambda c: c.astype(float).fillna(c.median()))
    y = sub[ycol].astype(int)
    from xgboost import XGBClassifier
    clf = XGBClassifier(**BTTS_PARAMS)
    clf.fit(X, y)
    out_dir = ROOT / "models"
    out_dir.mkdir(parents=True, exist_ok=True)
    artefact = {"model": clf, "features": feats, "market": market, "binary": True,
                "params": BTTS_PARAMS, "trained_on": "master_dataset.csv (Top-5 riche)"}
    path = out_dir / "xgb_btts_tuned.pkl"
    joblib.dump(artefact, path)
    print(f"[EXPORT] {path} | n_features={len(feats)} n_rows={len(sub)}")


if __name__ == "__main__":
    main()
