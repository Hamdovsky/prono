"""
Phase 0 : diagnostic + ré-entraînement de promosport_xgb.json (modèle dégénéré
vers 'X' à 96 %, cf CHANGELOG_AUDIT.md:19).

On réutilise les primitives du harnais walk-forward (core/backtest_walkforward)
=> même allowlist causale, même feature-engineering, AUCUNE fuite. Le nouveau
modèle promosport_xgb_v2.json remplace le dégénéré comme membre XGB de l'hybride.

Usage :
  data_pipeline/.venv/Scripts/python.exe scripts/retrain_promosport_xgb.py
"""
from __future__ import annotations
import json
import sys
import numpy as np
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.backtest_walkforward import (
    build_targets, load_master, leakage_tripwire,
    _make_models, run_backtest, FEATURE_ALLOWLIST,
)

MODELS = ROOT / "models"
OLD = MODELS / "promosport_xgb.json"
NEW = MODELS / "promosport_xgb_v2.json"


def diag_model(path: Path, df, feat_cols):
    """Charge un booster, infère sur df si possible, rapporte la distribution."""
    import xgboost as xgb
    if not path.exists():
        print(f"  [diag] {path.name} absent")
        return
    b = xgb.Booster()
    b.load_model(str(path))
    fn = b.feature_names or []
    print(f"  [diag] {path.name}: n_features={len(fn)}")
    if len(fn) == 0:
        print("  [diag]   MODELE CORROMPU (0 feature) -> inutilisable, a re-entrainer")
        return
    # inférence si les features du booster sont disponibles dans le df
    missing = [f for f in fn if f not in df.columns]
    if missing:
        print(f"  [diag]   features manquantes dans le dataset: {missing[:5]}... ({len(missing)})")
        return
    X = df[fn].apply(lambda c: c.astype(float).fillna(c.median()))
    dmat = xgb.DMatrix(X)
    p = b.predict(dmat)
    if p.ndim == 2:
        pred = np.argmax(p, axis=1)
        cls = ["H", "D", "A"]
        dist = {cls[i]: int((pred == i).sum()) for i in range(p.shape[1])}
        top = max(dist, key=dist.get)
        print(f"  [diag]   distribution argmax: {dist}  -> majoritaire={top} "
              f"({100*dist[top]/len(pred):.1f}%)")
    else:
        pred = (p >= 0.5).astype(int)
        print(f"  [diag]   prop pred=1: {pred.mean():.3f}")


def retrain():
    df = build_targets(load_master())
    market = "1x2"
    ycol = "y_1x2"
    sub = df.dropna(subset=[ycol])
    feats = [f for f in FEATURE_ALLOWLIST if f in sub.columns]
    feats = leakage_tripwire(sub, feats, market)
    X = sub[feats].apply(lambda c: c.astype(float).fillna(c.median()))
    y = sub[ycol].astype(int)
    print(f"[retrain] 1x2 : n={len(sub)} features={len(feats)}")

    factories = _make_models()
    clf = factories["xgb"](3)
    clf.fit(X, y)
    booster = clf.get_booster()
    booster.save_model(str(NEW))
    print(f"[retrain] sauvegardé -> {NEW.name}")

    # distribution sur le dataset complet (fit => optimiste, juste un sanity check)
    p = booster.predict(xgb_dmatrix(X))
    pred = np.argmax(p, axis=1)
    cls = ["H", "D", "A"]
    dist = {cls[i]: int((pred == i).sum()) for i in range(3)}
    top = max(dist, key=dist.get)
    print(f"[retrain] distribution argmax (fit): {dist} majoritaire={top} "
          f"({100*dist[top]/len(pred):.1f}%)")
    return feats


def xgb_dmatrix(X):
    import xgboost as xgb
    return xgb.DMatrix(X)


def main():
    print("=== Diagnostic modèle DÉGÉNÉRÉ (promosport_xgb.json) ===")
    df = build_targets(load_master())
    diag_model(OLD, df, None)

    print("\n=== Ré-entraînement propre (allowlist causale, sans fuite) ===")
    feats = retrain()

    print("\n=== Diagnostic nouveau modèle (promosport_xgb_v2.json) ===")
    diag_model(NEW, df, feats)

    print("\n=== Mesure OOF walk-forward (1x2, xgb) pour comparer au baseline 58.6% ===")
    res, audit = run_backtest(["1x2"], ["xgb"])
    import pprint
    pprint.pprint(res)


if __name__ == "__main__":
    main()
