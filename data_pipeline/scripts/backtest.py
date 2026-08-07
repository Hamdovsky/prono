"""Backtest marche-à-dire (walk-forward) du master dataset avec XGBoost.

Split TEMPOREL (TimeSeriesSplit) : on n'entraîne jamais sur le futur. Métriques
out-of-sample 1X2 : accuracy, log-loss, Brier multi-classe, par saison, matrice
de confusion, importance des features.

Options :
  --odds       ajoute les probabilités implicites des cotes (dispo pré-match)
  --calibrate  calibre les probabilités (isotonic) sur une tranche temporelle
               gardée de l'entraînement, pour corriger le Brier/log-loss

Usage :
    python scripts/backtest.py [--mode full|basic] [--odds] [--calibrate]
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import accuracy_score, confusion_matrix, log_loss
from sklearn.model_selection import TimeSeriesSplit
import xgboost as xgb

from ml_mapper import feature_names, prepare

ROOT = Path(__file__).resolve().parents[1]
MASTER_CSV = ROOT / "data" / "processed" / "master_dataset.csv"
MODELS_DIR = ROOT / "data" / "processed" / "models"
REPORTS_DIR = ROOT / "data" / "processed" / "reports"

CLASSES = [0, 1, 2]  # A, D, H
CLASS_LABELS = ["A", "D", "H"]
CAL_FRAC = 0.15  # part (temporelle) de l'entraînement réservée à la calibration


def build_model(seed: int) -> xgb.XGBClassifier:
    return xgb.XGBClassifier(
        objective="multi:softprob",
        num_class=3,
        n_estimators=400,
        max_depth=5,
        learning_rate=0.05,
        subsample=0.9,
        colsample_bytree=0.8,
        eval_metric="mlogloss",
        random_state=seed,
        n_jobs=-1,
    )


def multiclass_brier(y_true: np.ndarray, y_proba: np.ndarray) -> float:
    n = len(y_true)
    y_onehot = np.zeros((n, len(CLASSES)))
    y_onehot[np.arange(n), y_true] = 1.0
    return float(np.mean(np.sum((y_proba - y_onehot) ** 2, axis=1)))


def metrics(y_true: np.ndarray, proba: np.ndarray) -> dict:
    return {
        "accuracy": round(float(accuracy_score(y_true, np.argmax(proba, axis=1))), 4),
        "log_loss": round(float(log_loss(y_true, proba, labels=CLASSES)), 4),
        "brier": round(multiclass_brier(y_true, proba), 4),
    }


class _Calibrated:
    """Wrapper : modèle base + calibration isotonique par classe (1X2)."""

    def __init__(self, base, regressors):
        self.base = base
        self.regressors = regressors

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        p = self.base.predict_proba(X)
        out = np.column_stack([reg.predict(p[:, c]) for c, reg in enumerate(self.regressors)])
        total = out.sum(axis=1, keepdims=True)
        return out / np.where(total > 0, total, 1.0)


def calibrate_model(model, Xtr: pd.DataFrame, ytr: pd.Series, seed: int):
    """Calibration isotonique par classe sur la dernière tranche temporelle."""
    cal_size = max(int(CAL_FRAC * len(Xtr)), 200)
    X_fit, X_cal = Xtr.iloc[:-cal_size], Xtr.iloc[-cal_size:]
    y_fit, y_cal = ytr.iloc[:-cal_size], ytr.iloc[-cal_size:]
    base = build_model(seed)
    base.fit(X_fit, y_fit)
    proba_cal = base.predict_proba(X_cal)
    y_onehot = np.zeros((len(y_cal), len(CLASSES)))
    y_onehot[np.arange(len(y_cal)), y_cal.to_numpy()] = 1.0
    regressors = [IsotonicRegression(out_of_bounds="clip") for _ in CLASSES]
    for c in CLASSES:
        regressors[c].fit(proba_cal[:, c], y_onehot[:, c])
    return _Calibrated(base, regressors)


def run():
    parser = argparse.ArgumentParser(description="Backtest walk-forward du master XGBoost")
    parser.add_argument("--mode", choices=["full", "basic"], default="full")
    parser.add_argument("--splits", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--odds", action="store_true", help="ajouter les cotes implicites")
    parser.add_argument("--calibrate", action="store_true", help="calibrer (isotonic)")
    args = parser.parse_args()

    df = pd.read_csv(MASTER_CSV, parse_dates=["date"])
    print(f"[backtest] {len(df)} matchs chargés (mode={args.mode}, odds={args.odds}, calibrate={args.calibrate})")

    X, y, meta = prepare(df, mode=args.mode, dropna=True, use_odds=args.odds)
    X = X.reset_index(drop=True)
    y = y.reset_index(drop=True)
    meta = meta.reset_index(drop=True)
    print(f"[backtest] {len(X)} matchs exploitables, {X.shape[1]} features")

    order = np.argsort(meta["date"].to_numpy(), kind="stable")
    X, y, meta = X.iloc[order].reset_index(drop=True), y.iloc[order].reset_index(drop=True), meta.iloc[order].reset_index(drop=True)

    tscv = TimeSeriesSplit(n_splits=args.splits)
    oos_proba, oos_cal, oos_true = [], [], []
    fold_metrics = []
    importances = np.zeros(X.shape[1])

    for fold, (tr_idx, te_idx) in enumerate(tscv.split(X)):
        Xtr, Xte = X.iloc[tr_idx], X.iloc[te_idx]
        ytr, yte = y.iloc[tr_idx], y.iloc[te_idx]

        model = build_model(args.seed)
        model.fit(Xtr, ytr)
        proba = model.predict_proba(Xte)
        importances += model.feature_importances_

        m = {"fold": fold + 1, "train_size": int(len(tr_idx)), "test_size": int(len(te_idx)),
             "test_start": str(meta.iloc[te_idx[0]]["date"].date()),
             "test_end": str(meta.iloc[te_idx[-1]]["date"].date()),
             "raw": metrics(yte.to_numpy(), proba)}

        if args.calibrate:
            calibrator = calibrate_model(model, Xtr, ytr, args.seed)
            proba_cal = calibrator.predict_proba(Xte)
            m["calibrated"] = metrics(yte.to_numpy(), proba_cal)
        else:
            proba_cal = None

        oos_proba.append(proba)
        oos_true.append(yte.to_numpy())
        if proba_cal is not None:
            oos_cal.append(proba_cal)

        print(f"[backtest] fold {fold + 1}: test {m['test_start']} -> {m['test_end']} "
              f"| acc={m['raw']['accuracy']} ll={m['raw']['log_loss']} brier={m['raw']['brier']}"
              + (f" | cal acc={m['calibrated']['accuracy']} brier={m['calibrated']['brier']}" if proba_cal is not None else ""))
        fold_metrics.append(m)

    oos_proba = np.vstack(oos_proba)
    oos_true = np.concatenate(oos_true)
    oos_pred = np.argmax(oos_proba, axis=1)
    oos_meta = meta.iloc[np.concatenate([te_idx for _, te_idx in tscv.split(X)])].reset_index(drop=True)

    baseline = max(float((oos_true == 2).mean()), float((oos_true == 1).mean()), float((oos_true == 0).mean()))
    overall = {"n_test": int(len(oos_true)), "baseline_accuracy": round(baseline, 4), "raw": metrics(oos_true, oos_proba)}
    if oos_cal:
        oos_cal = np.vstack(oos_cal)
        overall["calibrated"] = metrics(oos_true, oos_cal)

    per_season = {}
    for season, idx in oos_meta.groupby("season").groups.items():
        s_true = oos_true[idx]
        entry = {"n": int(len(idx)), "raw": metrics(s_true, oos_proba[idx])}
        if oos_cal is not None:
            entry["calibrated"] = metrics(s_true, oos_cal[idx])
        per_season[str(season)] = entry

    cm = confusion_matrix(oos_true, oos_pred, labels=CLASSES).tolist()
    feat_imp = {name: round(float(imp / args.splits), 4) for name, imp in
                zip(feature_names(args.mode, args.odds), importances / args.splits)}
    feat_imp = dict(sorted(feat_imp.items(), key=lambda kv: kv[1], reverse=True))

    # Modèle final sur toutes les données exploitables (pour la prod)
    final = build_model(args.seed)
    final.fit(X, y)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    tag = f"{args.mode}{'_odds' if args.odds else ''}{'_cal' if args.calibrate else ''}"
    model_path = MODELS_DIR / f"prono_xgb_{tag}.json"
    final.save_model(str(model_path))

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": args.mode,
        "use_odds": args.odds,
        "calibrate": args.calibrate,
        "n_train": int(len(X)),
        "splits": args.splits,
        "seed": args.seed,
        "overall": overall,
        "per_season": per_season,
        "fold_metrics": fold_metrics,
        "confusion_matrix": {"labels": CLASS_LABELS, "matrix": cm},
        "feature_importance": feat_imp,
        "model_path": str(model_path),
    }
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    report_path = REPORTS_DIR / f"backtest_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print("\n===== RESUME OUT-OF-SAMPLE (1X2) =====")
    print(f"n test    : {overall['n_test']}")
    print(f"baseline  : {overall['baseline_accuracy']}")
    print(f"raw       : acc={overall['raw']['accuracy']} ll={overall['raw']['log_loss']} brier={overall['raw']['brier']}")
    if "calibrated" in overall:
        c = overall["calibrated"]
        print(f"calibrated: acc={c['accuracy']} ll={c['log_loss']} brier={c['brier']}")
    print("par saison:", json.dumps(per_season, indent=2))
    print(f"rapport   : {report_path}")
    print(f"modele    : {model_path}")


if __name__ == "__main__":
    run()
