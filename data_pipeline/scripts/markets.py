"""Backtest multi-marchés en walk-forward : 1X2, Over/Under 2.5, BTTS, Corners.

Chaque marché est évalué out-of-sample (TimeSeriesSplit, jamais de fuite).

Marchés avec cotes (1X2, O/U 2.5) :
  - la value est détectée avec les cotes d'ouverture moyennes (dispo pré-match) ;
  - le retour est calculé aux cotes de clôture moyennes (simulation honnête) ;
  - pari plat de 1 u quand edge = p_model - p_implicite >= --edge et p >= --min-prob.

Marchés sans cotes (BTTS, Corners) : probabilités seules (précision, Brier).

Usage :
    python scripts/markets.py [--markets 1x2 ou25 btts corners]
                              [--mode full|basic] [--splits 5] [--seed 42]
                              [--edge 0.04] [--min-prob 0.25]
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, log_loss
from sklearn.model_selection import TimeSeriesSplit
import xgboost as xgb

from ml_mapper import prepare

ROOT = Path(__file__).resolve().parents[1]
MASTER_CSV = ROOT / "data" / "processed" / "master_dataset.csv"
REPORTS_DIR = ROOT / "data" / "processed" / "reports"


def _t_1x2(df: pd.DataFrame) -> pd.Series:
    return df["ftr"].map({"H": 2, "D": 1, "A": 0})


def _t_ou25(df: pd.DataFrame) -> pd.Series:
    return (df["fthg"] + df["ftag"] > 2.5).astype(int)


def _t_btts(df: pd.DataFrame) -> pd.Series:
    return ((df["fthg"] > 0) & (df["ftag"] > 0)).astype(int)


def _t_corners(df: pd.DataFrame) -> pd.Series:
    return (df["hc"] + df["ac"] > 10.5).astype(int)


@dataclass
class MarketSpec:
    name: str
    kind: str  # "multiclass" | "binary"
    labels: list[str]
    target: object
    feat_mode: str
    use_odds: bool
    open_cols: list[str]   # colonnes de cotes d'ouverture (détection de value)
    close_cols: list[str]  # colonnes de cotes de clôture (settlement)
    outcome_map: dict[int, int] | None = None  # classe -> position dans proba


MARKETS: dict[str, MarketSpec] = {
    "1x2": MarketSpec(
        name="1X2", kind="multiclass", labels=["A", "D", "H"], target=_t_1x2,
        feat_mode="full", use_odds=True,
        open_cols=["odds_a_avg", "odds_d_avg", "odds_h_avg"],
        close_cols=["odds_a_close_avg", "odds_d_close_avg", "odds_h_close_avg"],
        outcome_map={0: 0, 1: 1, 2: 2},
    ),
    "ou25": MarketSpec(
        name="Over/Under 2.5", kind="binary", labels=["under", "over"], target=_t_ou25,
        feat_mode="full", use_odds=True,
        open_cols=["odds_u25_avg", "odds_o25_avg"],
        close_cols=["odds_u25_close_avg", "odds_o25_close_avg"],
        outcome_map={0: 0, 1: 1},
    ),
    "btts": MarketSpec(
        name="BTTS", kind="binary", labels=["no", "yes"], target=_t_btts,
        feat_mode="full", use_odds=False, open_cols=[], close_cols=[], outcome_map=None,
    ),
    "corners": MarketSpec(
        name="Corners 10.5", kind="binary", labels=["under", "over"], target=_t_corners,
        feat_mode="basic", use_odds=False, open_cols=[], close_cols=[], outcome_map=None,
    ),
}


def build_classifier(spec: MarketSpec, seed: int, scale_pos_weight: float = 1.0) -> xgb.XGBClassifier:
    if spec.kind == "multiclass":
        return xgb.XGBClassifier(
            objective="multi:softprob", num_class=3,
            n_estimators=400, max_depth=5, learning_rate=0.05,
            subsample=0.9, colsample_bytree=0.8, eval_metric="mlogloss",
            random_state=seed, n_jobs=-1,
        )
    return xgb.XGBClassifier(
        objective="binary:logistic", eval_metric="logloss",
        n_estimators=400, max_depth=5, learning_rate=0.05,
        subsample=0.9, colsample_bytree=0.8, scale_pos_weight=scale_pos_weight,
        random_state=seed, n_jobs=-1,
    )


def _brier(y_true: np.ndarray, proba: np.ndarray) -> float:
    if proba.shape[1] == 2:
        return float(np.mean((proba[:, 1] - y_true) ** 2))
    y_onehot = np.zeros((len(y_true), proba.shape[1]))
    y_onehot[np.arange(len(y_true)), y_true.astype(int)] = 1.0
    return float(np.mean(np.sum((proba - y_onehot) ** 2, axis=1)))


def _metrics(y_true: np.ndarray, proba: np.ndarray) -> dict:
    labels = list(range(proba.shape[1]))
    return {
        "accuracy": round(float(accuracy_score(y_true, np.argmax(proba, axis=1))), 4),
        "log_loss": round(float(log_loss(y_true, proba, labels=labels)), 4),
        "brier": round(_brier(y_true, proba), 4),
    }


def simulate_value(proba: np.ndarray, y_true: np.ndarray,
                   odds_open: np.ndarray, odds_close: np.ndarray,
                   edge_thr: float, min_prob: float) -> dict:
    """Parie 1 u sur l'issue à plus forte edge (ouverture), solde à la clôture."""
    n_ok = n_won = 0
    returned = 0.0
    by_outcome: dict[int, int] = {}
    for i in range(len(y_true)):
        edges: dict[int, float] = {}
        for k in range(proba.shape[1]):
            o = odds_open[i, k]
            edges[k] = float(proba[i, k]) - (1.0 / o if o and o > 1 else 0.0)
        k = max(edges, key=edges.get)
        if edges[k] < edge_thr or proba[i, k] < min_prob or not (odds_close[i, k] > 1):
            continue
        n_ok += 1
        by_outcome[k] = by_outcome.get(k, 0) + 1
        if y_true[i] == k:
            n_won += 1
            returned += float(odds_close[i, k])
    return {
        "n_bets": n_ok,
        "staked": float(n_ok),
        "returned": round(returned, 2),
        "roi": round((returned - n_ok) / n_ok, 4) if n_ok else None,
        "hit_rate": round(n_won / n_ok, 4) if n_ok else None,
        "by_outcome": by_outcome,
    }


def backtest_market(df: pd.DataFrame, spec: MarketSpec, args) -> dict:
    X, y, meta = prepare(df, mode=spec.feat_mode, dropna=True,
                         use_odds=spec.use_odds, target=spec.target)
    sel = df.loc[X.index].copy()
    X, y, meta, sel = X.reset_index(drop=True), y.reset_index(drop=True), \
        meta.reset_index(drop=True), sel.reset_index(drop=True)

    order = np.argsort(meta["date"].to_numpy(), kind="stable")
    X, y, meta, sel = X.iloc[order], y.iloc[order], meta.iloc[order], sel.iloc[order]

    tscv = TimeSeriesSplit(n_splits=args.splits)
    oos_proba, oos_true = [], []
    fold_metrics = []
    importances = np.zeros(X.shape[1])
    test_positions = []

    for fold, (tr_idx, te_idx) in enumerate(tscv.split(X)):
        ytr = y.iloc[tr_idx]
        scale = 1.0
        if spec.kind == "binary":
            pos = float(ytr.sum())
            scale = (len(ytr) - pos) / max(pos, 1.0)
        model = build_classifier(spec, args.seed, scale_pos_weight=scale)
        model.fit(X.iloc[tr_idx], ytr)
        proba = model.predict_proba(X.iloc[te_idx])
        importances += model.feature_importances_
        yte = y.iloc[te_idx].to_numpy()
        oos_proba.append(proba)
        oos_true.append(yte)
        test_positions.append(te_idx)
        fold_metrics.append({
            "fold": fold + 1,
            "test_size": int(len(te_idx)),
            "test_start": str(meta.iloc[te_idx[0]]["date"].date()),
            "test_end": str(meta.iloc[te_idx[-1]]["date"].date()),
            "metrics": _metrics(yte, proba),
        })

    oos_proba = np.vstack(oos_proba)
    oos_true = np.concatenate(oos_true)
    test_positions = np.concatenate(test_positions)
    baseline = max(float((oos_true == c).mean()) for c in np.unique(oos_true))
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "market": spec.name,
        "kind": spec.kind,
        "labels": spec.labels,
        "feat_mode": spec.feat_mode,
        "use_odds": spec.use_odds,
        "splits": args.splits,
        "seed": args.seed,
        "overall": {"n_test": int(len(oos_true)),
                    "baseline_accuracy": round(baseline, 4),
                    **{k: v for k, v in _metrics(oos_true, oos_proba).items()}},
        "fold_metrics": fold_metrics,
    }

    if spec.use_odds and len(spec.open_cols):
        odds_open = sel[spec.open_cols].to_numpy(dtype=float)
        odds_close = sel[spec.close_cols].to_numpy(dtype=float)
        report["value"] = simulate_value(oos_proba, oos_true,
                                         odds_open[test_positions],
                                         odds_close[test_positions],
                                         args.edge, args.min_prob)
        report["value"]["edge_threshold"] = args.edge
        report["value"]["min_prob"] = args.min_prob

    if spec.kind == "binary":
        p1 = oos_proba[:, 1]
        report["threshold"] = {
            "n_predictions": int(len(p1)),
            "predicted_yes": int((p1 >= 0.5).sum()),
            "yes_rate": round(float(p1.mean()), 4),
            "accuracy_50": round(float(accuracy_score(oos_true, (p1 >= 0.5).astype(int))), 4),
        }

    imp = {name: round(float(v / args.splits), 4)
           for name, v in zip(X.columns, importances / args.splits)}
    report["feature_importance"] = dict(sorted(imp.items(), key=lambda kv: kv[1], reverse=True)[:10])
    return report


def run():
    parser = argparse.ArgumentParser(description="Backtest multi-marchés XGBoost")
    parser.add_argument("--markets", nargs="+", choices=list(MARKETS), default=list(MARKETS))
    parser.add_argument("--mode", choices=["full", "basic"], default="full")
    parser.add_argument("--splits", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--edge", type=float, default=0.04)
    parser.add_argument("--min-prob", type=float, default=0.25)
    args = parser.parse_args()

    df = pd.read_csv(MASTER_CSV, parse_dates=["date"])
    print(f"[markets] {len(df)} matchs chargés — {len(args.markets)} marchés")

    reports = {}
    for market in args.markets:
        spec = MARKETS[market]
        print(f"\n===== {spec.name} (mode={spec.feat_mode}, odds={spec.use_odds}) =====")
        rep = backtest_market(df, spec, args)
        reports[market] = rep
        o = rep["overall"]
        print(f"n test={o['n_test']} baseline={o['baseline_accuracy']} "
              f"acc={o['accuracy']} ll={o['log_loss']} brier={o['brier']}")
        if "value" in rep:
            v = rep["value"]
            print(f"VALUE (edge>={args.edge}, p>={args.min_prob}) : {v['n_bets']} paris, "
                  f"roi={v['roi']}, hit={v['hit_rate']}, ret={v['returned']}/{v['staked']}")
        if "threshold" in rep:
            t = rep["threshold"]
            print(f"Seuil 0.5 : acc={t['accuracy_50']} (yes={t['predicted_yes']}/{t['n_predictions']}, "
                  f"taux yes observé={t['yes_rate']})")

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out = REPORTS_DIR / f"markets_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}.json"
    out.write_text(json.dumps(reports, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nRapports : {out}")


if __name__ == "__main__":
    run()
