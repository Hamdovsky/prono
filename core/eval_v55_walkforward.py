import os
import sys
import json
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from sklearn.metrics import log_loss, classification_report

from train_v55 import load_data
from ml_features import FEATURE_NAMES_V55, FEATURE_NAMES_V55_NOCLOSE, CLOSING_DERIVED_FEATURES


MODELS = {
    "prod_v55_optimized": os.path.join(HERE, "..", "models", "stitch_v55_optimized.json"),
    "pref1_v55": os.path.join(HERE, "..", "models", "stitch_v55_optimized_preF1.json"),
    "noclose_v55": os.path.join(HERE, "..", "models", "stitch_v55_noclose.json"),
}
REPORT_PATH = os.path.join(HERE, "..", "data", "v55_walkforward_report.json")


def chronological_split(match_dates, test_frac=0.20):
    """Strict chronological split: train = oldest, test = most recent, no overlap.
    Returns (train_idx, test_idx) as numpy int arrays. Rows with unparseable
    dates are dropped. This REPLACES the previous random stratified split that
    leaked future information into training."""
    arr = np.arange(len(match_dates))
    parsed = []
    for i, d in enumerate(match_dates):
        try:
            ts = pd_timestamp(str(d))
        except Exception:
            ts = None
        parsed.append(ts)
    valid = [(i, t) for i, t in zip(arr, parsed) if t is not None]
    if not valid:
        raise ValueError("No parseable match dates for chronological split")
    idx_sorted = [i for i, _ in sorted(valid, key=lambda kv: kv[1])]
    n = len(idx_sorted)
    n_test = max(1, int(round(n * test_frac)))
    train_idx = np.array(idx_sorted[:-n_test], dtype=int)
    test_idx = np.array(idx_sorted[-n_test:], dtype=int)
    return train_idx, test_idx


def pd_timestamp(s):
    import pandas as pd
    return pd.Timestamp(s)


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
        if i == n_bins - 1:
            m = (conf >= lo) & (conf <= hi)
        else:
            m = (conf >= lo) & (conf < hi)
        cnt = int(m.sum())
        if cnt == 0:
            continue
        acc = float((pred[m] == y_true[m]).mean())
        avg_conf = float(conf[m].mean())
        ece += abs(acc - avg_conf) * (cnt / total)
    return ece


def evaluate_predictions(y_true, proba, names=("H", "D", "A")):
    y_true = np.asarray(y_true)
    proba = np.asarray(proba)
    pred = proba.argmax(axis=1)
    acc = float((pred == y_true).mean())
    ll = float(log_loss(y_true, proba, labels=[0, 1, 2]))
    br = brier_score(proba, y_true)
    ece = ece_score(proba, y_true)
    rep = classification_report(y_true, pred, labels=[0, 1, 2], target_names=list(names),
                                output_dict=True, zero_division=0)
    per_class = {}
    for k in names:
        per_class[k] = {
            "precision": rep[k]["precision"],
            "recall": rep[k]["recall"],
            "f1": rep[k]["f1-score"],
            "support": rep[k]["support"],
        }
    return {
        "accuracy": acc,
        "log_loss": ll,
        "brier": br,
        "ece": ece,
        "per_class": per_class,
    }


def draw_prior_sweep(y_true, proba, k_grid=None):
    """Find the draw-prior multiplier k (bounded) that minimises log-loss on a set.
    Applied as p_d *= k then renormalise. Returns best_k and its log-loss."""
    if k_grid is None:
        k_grid = np.linspace(0.8, 1.3, 11)
    y_true = np.asarray(y_true)
    proba = np.asarray(proba)
    best = None
    for k in k_grid:
        adj = proba.copy()
        adj[:, 1] = adj[:, 1] * k
        s = adj.sum(axis=1, keepdims=True)
        adj = adj / s
        ll = float(log_loss(y_true, adj, labels=[0, 1, 2]))
        if best is None or ll < best[1]:
            best = (float(k), ll)
    return {"best_k": best[0], "best_logloss": best[1]}


def evaluate_model(path, X, y, sw, feature_names, zero_closing=True):
    import xgboost as xgb
    booster = xgb.Booster()
    booster.load_model(path)
    fn = [f for f in feature_names if f in X.columns]
    Xs = X[fn].copy()
    if zero_closing:
        for c in CLOSING_DERIVED_FEATURES:
            if c in Xs.columns:
                Xs[c] = 0.0
    Xs = Xs.astype(float).values
    train_proba = booster.predict(xgb.DMatrix(Xs, feature_names=fn))
    return train_proba


def _predict_on_split(booster_proba_full, train_idx, test_idx, y, sw):
    train_proba = booster_proba_full[train_idx]
    test_proba = booster_proba_full[test_idx]
    train_metrics = evaluate_predictions(y[train_idx], train_proba)
    test_metrics = evaluate_predictions(y[test_idx], test_proba)
    return train_metrics, test_metrics


def main():
    import pandas as pd
    global pd_timestamp
    pd_timestamp = pd.Timestamp

    tag = "V55"
    limit = int(os.environ.get("V55_EVAL_LIMIT", "30000"))
    print("[%s] Loading data (limit=%d) for honest chronological evaluation..." % (tag, limit))
    X, y, sw, match_dates = load_data(limit=limit, feature_names=FEATURE_NAMES_V55)
    print("[%s] rows=%d features=%d" % (tag, len(X), X.shape[1]))

    train_idx, test_idx = chronological_split(match_dates, test_frac=0.20)
    date_min = str(match_dates[train_idx.min()]) if len(train_idx) else "?"
    date_max = str(match_dates[test_idx.max()]) if len(test_idx) else "?"
    train_max = str(match_dates[train_idx.max()]) if len(train_idx) else "?"
    test_min = str(match_dates[test_idx.min()]) if len(test_idx) else "?"
    print("[%s] chronological split: train=%d (oldest) test=%d (most recent)" % (tag, len(train_idx), len(test_idx)))
    print("[%s] train period ..%s | test period %s..%s" % (tag, train_max, test_min, date_max))

    results = {
        "split": {
            "method": "chronological (oldest=train, most_recent=test, no overlap)",
            "n_train": int(len(train_idx)),
            "n_test": int(len(test_idx)),
            "train_period_end": train_max,
            "test_period_start": test_min,
            "class_distribution": {
                "Home": int((y == 0).sum()),
                "Draw": int((y == 1).sum()),
                "Away": int((y == 2).sum()),
            },
        },
        "models": {},
    }

    for name, path in MODELS.items():
        if not os.path.exists(path):
            print("[SKIP] model missing: %s (%s)" % (name, path))
            continue
        feats = FEATURE_NAMES_V55_NOCLOSE if name == "noclose_v55" else FEATURE_NAMES_V55
        print("[EVAL] %s ..." % name)
        proba_full = evaluate_model(path, X, y, sw, feats, zero_closing=True)
        train_m, test_m = _predict_on_split(proba_full, train_idx, test_idx, y, sw)
        results["models"][name] = {
            "train": train_m,
            "test": test_m,
        }
        print("   test acc=%.4f log_loss=%.4f brier=%.4f ece=%.4f" % (
            test_m["accuracy"], test_m["log_loss"], test_m["brier"], test_m["ece"]))
        print("   per-class recall H/D/A = %.3f/%.3f/%.3f" % (
            test_m["per_class"]["H"]["recall"],
            test_m["per_class"]["D"]["recall"],
            test_m["per_class"]["A"]["recall"]))
        dp = draw_prior_sweep(y[test_idx], proba_full[test_idx])
        results["models"][name]["best_draw_prior"] = dp
        print("   draw-prior sweep: best_k=%.3f -> log_loss=%.4f" % (dp["best_k"], dp["best_logloss"]))

    # Improvement summary vs pref1
    if "pref1_v55" in results["models"] and "prod_v55_optimized" in results["models"]:
        d = (results["models"]["prod_v55_optimized"]["test"]["accuracy"]
             - results["models"]["pref1_v55"]["test"]["accuracy"])
        results["improvement_prod_vs_pref1"] = float(d)
        print("[SUMMARY] prod vs pref1 test-accuracy delta = %+.4f" % d)

    with open(REPORT_PATH, "w") as f:
        json.dump(results, f, indent=2, default=str)
    print("[OK] report written -> %s" % REPORT_PATH)


if __name__ == "__main__":
    main()
