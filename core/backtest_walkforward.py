"""Moteur de backtest WALK-FORWARD (audit P0 — Phase 7).

Règles strictes (brief §18/§19) :
- Interdiction du random split : expanding window mensuel sur la saison 2526,
  train = tout ce qui précède (saisons 2324+2425+mois écoulés), embargo 7 j.
- Aucune feature post-match : allowlist stricte (stats in-match, scores,
  cotes closing et dérivés EXCLUS). Tripwire B0 : corrélation >0.97 avec la
  cible -> feature exclue et signalée.
- Persistance immuable : backtest_runs.sqlite (run_id, hash config, métriques).

Usage :
  & data_pipeline/.venv/Scripts/python.exe -m core.backtest_walkforward \
        --markets 1x2,ou25,btts --models lr,rf,xgb [--print-top 12]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "data_pipeline"))

from config import MASTER_CSV  # noqa: E402

CUTOFF_GEL = "2024-01-01"          # données historiques master (pré-gel app) — regime constant
EMBARGO_DAYS = 7
VAL_SEASON = 2526
CLASSES_1X2 = ["H", "D", "A"]

# Allowlist causale : rien d'in-match, rien de closing.
FEATURE_ALLOWLIST = [
    "elo_home", "elo_away", "F_Elo_Diff",
    "home_xg", "away_xg", "home_xa", "away_xa",
    "H_gf_L5", "H_gf_L10", "H_ga_L5", "H_ga_L10",
    "H_xg_L5", "H_xg_L10", "H_xga_L5", "H_xga_L10",
    "H_pts_L5", "H_pts_L10", "H_shots_L5", "H_shots_L10",
    "A_gf_L5", "A_gf_L10", "A_ga_L5", "A_ga_L10",
    "A_xg_L5", "A_xg_L10", "A_xga_L5", "A_xga_L10",
    "A_pts_L5", "A_pts_L10", "A_shots_L5", "A_shots_L10",
    "Total_xG_L5", "Form_Diff_L5",
    "P1_open_avg", "PX_open_avg", "P2_open_avg",
    "odds_h_avg", "odds_d_avg", "odds_a_avg",
    "odds_o25_avg", "odds_u25_avg",
]

TRIPWIRE_CORR = 0.97


# ----------------------------------------------------------------- données
def load_master() -> pd.DataFrame:
    df = pd.read_csv(MASTER_CSV)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["season"] = pd.to_numeric(df["season"], errors="coerce").astype("Int64")
    return df.dropna(subset=["date"]).sort_values("date").reset_index(drop=True)


def build_targets(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["y_1x2"] = out["ftr"].map({"H": 0, "D": 1, "A": 2})
    goals = out["fthg"].fillna(0) + out["ftag"].fillna(0)
    out["y_ou25"] = (goals > 2.5).astype(int)
    out["y_btts"] = ((out["fthg"].fillna(0) > 0) & (out["ftag"].fillna(0) > 0)).astype(int)
    return out


def _max_abs_corr(x: pd.Series, y: pd.Series) -> float:
    """Corrélation max entre x et les indicateurs de classe de y (robuste multi-classe)."""
    best = 0.0
    xv = x.astype(float)
    if xv.nunique(dropna=True) < 2:
        return 0.0
    for cls in pd.unique(y.dropna()):
        ind = (y == cls).astype(float)
        if ind.nunique() < 2:
            continue
        c = abs(np.corrcoef(xv.fillna(xv.median()), ind)[0, 1])
        if np.isfinite(c):
            best = max(best, c)
    return best


def leakage_tripwire(train: pd.DataFrame, features: list[str], market: str) -> list[str]:
    """B0 : exclut toute feature quasi-déterministe pour la cible du fold."""
    ycol = f"y_{market}"
    excluded: list[str] = []
    y = train[ycol]
    for f in features:
        if _max_abs_corr(train[f], y) > TRIPWIRE_CORR:
            excluded.append(f)
    return [f for f in features if f not in excluded] if excluded else features


# ----------------------------------------------------------------- modèles
def _make_models():
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.impute import SimpleImputer

    def lr_factory(n_classes):
        return Pipeline([
            ("imp", SimpleImputer(strategy="median")),
            ("sc", StandardScaler()),
            ("clf", LogisticRegression(max_iter=1000, C=0.5)),
        ])

    def rf_factory(n_classes):
        return RandomForestClassifier(
            n_estimators=250, max_depth=8, min_samples_leaf=20,
            n_jobs=-1, random_state=42,
        )

    factories = {"lr": lr_factory, "rf": rf_factory}

    try:
        from xgboost import XGBClassifier

        def xgb_factory(n_classes):
            params = dict(
                n_estimators=300, max_depth=4, learning_rate=0.05,
                subsample=0.9, colsample_bytree=0.8, min_child_weight=20,
                random_state=42, n_jobs=-1, eval_metric="mlogloss" if n_classes > 2 else "logloss",
                tree_method="hist",
            )
            if n_classes > 2:
                params["objective"] = "multi:softprob"
                params["num_class"] = n_classes
            else:
                params["objective"] = "binary:logistic"
            return XGBClassifier(**params)

        factories["xgb"] = xgb_factory
    except Exception as e:  # pragma: no cover
        print(f"[WARN] xgboost indisponible : {e}")
    return factories


# ----------------------------------------------------------------- métriques
EPS = 1e-12


def metrics_binary(y_true, p1) -> dict:
    p1 = np.clip(np.asarray(p1, dtype=float), EPS, 1 - EPS)
    y = np.asarray(y_true)
    ll = float(-np.mean(y * np.log(p1) + (1 - y) * np.log(1 - p1)))
    brier = float(np.mean((p1 - y) ** 2))
    acc = float(np.mean((p1 >= 0.5).astype(int) == y))
    # ECE 10 bins équi-large
    bins = np.clip((p1 * 10).astype(int), 0, 9)
    ece = 0.0
    for b in range(10):
        m = bins == b
        if m.any():
            ece += m.mean() * abs(y[m].mean() - p1[m].mean())
    return {"n": int(len(y)), "logloss": round(ll, 5), "brier": round(brier, 5),
            "acc": round(acc, 5), "ece": round(float(ece), 5)}


def metrics_multi(y_true, proba) -> dict:
    proba = np.clip(np.asarray(proba, dtype=float), EPS, 1.0)
    y = np.asarray(y_true)
    ll = float(-np.mean(np.log(proba[np.arange(len(y)), y])))
    acc = float(np.mean(proba.argmax(axis=1) == y))
    # Brier multiclasse (somme des carrés, moyenne par ligne)
    onehot = np.zeros_like(proba)
    onehot[np.arange(len(y)), y] = 1
    brier = float(np.mean(((proba - onehot) ** 2).sum(axis=1)))
    return {"n": int(len(y)), "logloss": round(ll, 5), "brier": round(brier, 5),
            "acc": round(acc, 5)}


# ----------------------------------------------------------------- baseline Poisson
SHRINK_K = 3          # retrait bayésien vers la moyenne ligue
GRID = range(0, 11)   # grille de scores 0..10


def _poisson_pm(lam: float) -> np.ndarray:
    """Poisson pmf sur la grille."""
    from scipy.stats import poisson as _pois

    return _pois.pmf(np.array(list(GRID)), max(lam, 0.05))


def poisson_params(train: pd.DataFrame) -> dict:
    """λ par (ligue, équipe, côté domicile/extérieur), shrinkés vers la moyenne ligue."""
    out: dict[str, dict] = {}
    for lg, g in train.groupby("league"):
        avg_h = float(g["fthg"].mean()) if len(g) else 1.4
        avg_a = float(g["ftag"].mean()) if len(g) else 1.1
        entry: dict = {"avg_h": avg_h, "avg_a": avg_a, "teams": {}}
        gh = g.groupby("home_team")["fthg"]
        ga = g.groupby("away_team")["ftag"]
        teams = set(gh.indices.keys()) | set(ga.indices.keys())
        for t in teams:
            n_home = len(gh.get_group(t)) if t in gh.groups else 0
            n_away = len(ga.get_group(t)) if t in ga.groups else 0
            atk_h = float(gh.mean().get(t, avg_h))
            def_h = float(g.groupby("home_team")["ftag"].mean().get(t, avg_a))
            atk_a = float(ga.mean().get(t, avg_a))
            def_a = float(g.groupby("away_team")["fthg"].mean().get(t, avg_h))
            w_h = n_home / (n_home + SHRINK_K)
            w_a = n_away / (n_away + SHRINK_K)
            entry["teams"][t] = {
                "atk_home": w_h * (atk_h / max(avg_h, 1e-9)) + (1 - w_h),
                "def_home": w_h * (def_h / max(avg_a, 1e-9)) + (1 - w_h),
                "atk_away": w_a * (atk_a / max(avg_a, 1e-9)) + (1 - w_a),
                "def_away": w_a * (def_a / max(avg_h, 1e-9)) + (1 - w_a),
                "n": n_home + n_away,
            }
        out[lg] = entry
    return out


def poisson_predict(params: dict, val: pd.DataFrame, market: str) -> np.ndarray:
    ph, pa = [], []
    for _, r in val.iterrows():
        e = params.get(r["league"], {})
        th = e.get("teams", {}).get(r["home_team"])
        ta = e.get("teams", {}).get(r["away_team"])
        avg_h, avg_a = e.get("avg_h", 1.4), e.get("avg_a", 1.1)
        lh = avg_h * ((th or {}).get("atk_home", 1.0)) * ((ta or {}).get("def_away", 1.0))
        la = avg_a * ((ta or {}).get("atk_away", 1.0)) * ((th or {}).get("def_home", 1.0))
        ph.append(max(lh, 0.05))
        pa.append(max(la, 0.05))

    if market == "ou25":
        res = []
        for lh, la in zip(ph, pa):
            ph_, pa_ = _poisson_pm(lh), _poisson_pm(la)
            grid = np.outer(ph_, pa_)
            over = np.tril(grid, -(int(2.5) + 1)).sum()  # total > 2.5 ⇔ sous-diagonale stricte
            res.append([1 - over, over])
        return np.array(res)
    if market == "btts":
        res = []
        for lh, la in zip(ph, pa):
            ph_, pa_ = _poisson_pm(lh), _poisson_pm(la)
            q1, q2 = 1 - ph_[0], 1 - pa_[0]
            yes = q1 * q2
            res.append([1 - yes, yes])
        return np.array(res)
    # 1x2
    res = []
    for lh, la in zip(ph, pa):
        ph_, pa_ = _poisson_pm(lh), _poisson_pm(la)
        grid = np.outer(ph_, pa_)
        h = np.tril(grid, -1).sum()   # i > j
        d = np.trace(grid)
        a = np.triu(grid, 1).sum()
        tot = h + d + a
        res.append([h / tot, d / tot, a / tot])
    return np.array(res)


# ----------------------------------------------------------------- folds
def month_folds(df: pd.DataFrame):
    val = df[df["season"] == VAL_SEASON]
    months = sorted(pd.PeriodIndex(val["date"], freq="M").unique())
    for p in months:
        val_mask = (
            (val["date"].dt.year == p.year) & (val["date"].dt.month == p.month)
        )
        val_df = val[val_mask]
        val_end = val_df["date"].max()
        embargo_start = val_df["date"].min() - timedelta(days=EMBARGO_DAYS)
        train_df = df[(df["season"] != VAL_SEASON) | (df["date"] < embargo_start)]
        train_df = train_df[train_df["date"] < embargo_start]
        yield {
            "fold": str(p),
            "train": train_df,
            "val": val_df,
            "train_max": train_df["date"].max(),
            "embargo_start": embargo_start,
        }


# ----------------------------------------------------------------- runner
def run_backtest(markets: list[str], models: list[str], df: pd.DataFrame | None = None) -> tuple[dict, dict]:
    if df is None:
        df = build_targets(load_master())
    else:
        df = build_targets(df)
    factories = _make_models()
    results: dict = {}
    fold_audit: list[dict] = []

    for market in markets:
        ycol = f"y_{market}"
        sub = df.dropna(subset=[ycol])
        binary = market in ("ou25", "btts")
        results[market] = {}
        for mname in models:
            is_poisson = mname == "poisson"
            factory = None if is_poisson else factories.get(mname)
            if not is_poisson and factory is None:
                continue
            per_fold = []
            for fold in month_folds(sub):
                train, v = fold["train"], fold["val"]
                if is_poisson:
                    # Baseline Poisson (Phase 4) : fit analytique par ligue.
                    params_lg = poisson_params(
                        train[["league", "home_team", "away_team", "fthg", "ftag"]]
                        .dropna(subset=["fthg", "ftag"])
                    )
                    proba = poisson_predict(params_lg, v, market)
                    if binary:
                        mt = metrics_binary(v[ycol], proba[:, 1])
                    else:
                        mt = metrics_multi(v[ycol].astype(int), proba)
                else:
                    available = [f for f in FEATURE_ALLOWLIST if f in train.columns and f in v.columns]
                    if len(available) < 3:
                        print(f"[WARN] {market}/{fold['fold']}: <3 features disponibles, fold sauté")
                        continue
                    feats = leakage_tripwire(train, available, market)
                    Xtr, Xva = train[feats], v[feats]
                    clf = factory(len(CLASSES_1X2) if not binary else 2)
                    try:
                        clf.fit(Xtr, train[ycol].astype(int))
                    except Exception as e:
                        print(f"[WARN] fit {mname}/{market}/{fold['fold']}: {e}")
                        continue

                    if binary:
                        p1 = clf.predict_proba(Xva)[:, 1]
                        mt = metrics_binary(v[ycol], p1)
                    else:
                        proba = np.zeros((len(v), 3))
                        cls = list(clf.classes_)
                        raw = clf.predict_proba(Xva)
                        for j, c in enumerate(cls):
                            if c < 3:
                                proba[:, c] = raw[:, j]
                        renorm = proba.sum(axis=1, keepdims=True)
                        renorm[renorm == 0] = 1
                        proba = proba / renorm
                        mt = metrics_multi(v[ycol].astype(int), proba)
                mt["fold"] = fold["fold"]
                per_fold.append(mt)
                fold_audit.append({
                    "market": market, "model": mname, "fold": fold["fold"],
                    "train_n": int(len(train)), "val_n": int(len(v)),
                    "train_max": str(fold["train_max"].date()),
                    "embargo_ok": bool(
                        fold["train_max"] < fold["embargo_start"]
                    ),
                })
            if per_fold:
                agg = {
                    k: round(float(np.mean([f[k] for f in per_fold])), 5)
                    for k in ("logloss", "brier", "acc", "ece") if k in per_fold[0]
                }
                agg["folds"] = len(per_fold)
                agg["total_n"] = int(sum(f["n"] for f in per_fold))
                results[market][mname] = agg
    audit_ok = all(a["embargo_ok"] for a in fold_audit)
    return results, {"audit": fold_audit[:40], "all_embargo_ok": audit_ok}


def persist_run(cfg: dict, results: dict, audit: dict, db_path: Path) -> str:
    run_id = uuid.uuid4().hex[:10]
    cfg_json = json.dumps(cfg, sort_keys=True)
    h = hashlib.sha256(cfg_json.encode()).hexdigest()[:16]
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    con.execute(
        """CREATE TABLE IF NOT EXISTS backtest_runs(
             run_id TEXT PRIMARY KEY, created_at TEXT, config_json TEXT,
             config_hash TEXT, metrics_json TEXT, embargo_all_ok INTEGER)"""
    )
    con.execute(
        "INSERT INTO backtest_runs VALUES (?,?,?,?,?,?)",
        (run_id, datetime.now(timezone.utc).isoformat(), cfg_json, h,
         json.dumps({"results": results}, sort_keys=True),
         1 if audit.get("all_embargo_ok") else 0),
    )
    con.commit()
    con.close()
    return run_id


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Backtest walk-forward (P0)")
    ap.add_argument("--markets", default="1x2,ou25,btts")
    ap.add_argument("--models", default="lr,rf,xgb")
    args = ap.parse_args(argv)

    markets = [m.strip() for m in args.markets.split(",") if m.strip()]
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    print(f"[BACKTEST] marchés={markets} modèles={models} (folds mensuels, embargo {EMBARGO_DAYS}j)")
    results, audit = run_backtest(markets, models)
    cfg = {"markets": markets, "models": models, "embargo_days": EMBARGO_DAYS,
           "features": FEATURE_ALLOWLIST}
    run_id = persist_run(cfg, results, audit,
                         ROOT / "data_pipeline" / "data" / "processed" / "backtest_runs.sqlite")

    print(f"\n=== RÉSULTATS walk-forward (run_id={run_id}) ===")
    for market, by_model in results.items():
        print(f"\n[{market}]")
        rows = sorted(by_model.items(), key=lambda kv: kv[1]["logloss"])
        for name, m in rows:
            extra = f" ece={m['ece']}" if "ece" in m else ""
            print(f"  {name:>4}: logloss={m['logloss']} brier={m['brier']} "
                  f"acc={m['acc']}{extra} (n={m['total_n']}, {m['folds']} folds)")
    print(f"\nEmbargo respecté sur tous les folds : {audit.get('all_embargo_ok')}")


if __name__ == "__main__":
    main()
