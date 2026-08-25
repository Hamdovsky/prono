"""Tests du moteur walk-forward (audit P0 Phase 7) — dataset synthétique."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "data_pipeline"))

from core.backtest_walkforward import (  # noqa: E402
    build_targets,
    leakage_tripwire,
    month_folds,
    poisson_params,
    poisson_predict,
    run_backtest,
    train_baselines,
)


def _synthetic(n_train=400, n_val=60):
    rng = np.random.default_rng(42)
    dates = pd.date_range("2023-08-01", periods=n_train + n_val, freq="D")
    df = pd.DataFrame({
        "date": dates,
        "league": "E0",
        "season": [2324] * n_train + [2526] * n_val,
        "home_team": rng.choice(["A", "B", "C", "D"], len(dates)),
        "away_team": rng.choice(["E", "F", "G", "H"], len(dates)),
        "fthg": rng.poisson(1.5, len(dates)),
        "ftag": rng.poisson(1.2, len(dates)),
        "elo_home": rng.normal(1700, 80, len(dates)),
        "elo_away": rng.normal(1650, 80, len(dates)),
        "H_pts_L5": rng.integers(0, 15, len(dates)).astype(float),
        "A_pts_L5": rng.integers(0, 15, len(dates)).astype(float),
    })
    df["ftr"] = np.where(df.fthg > df.ftag, "H", np.where(df.fthg == df.ftag, "D", "A"))
    return df


def test_embargo_respecte():
    df = _synthetic()
    folds = list(month_folds(df))
    assert folds
    for f in folds:
        assert f["train_max"] < f["embargo_start"]
        assert (f["val"]["date"] >= f["embargo_start"]).all()


def test_tripwire_exclut_la_leakage():
    df = build_targets(_synthetic())
    df["cheat"] = (df["fthg"] > df["ftag"]).astype(float)
    feats = leakage_tripwire(df, ["elo_home", "cheat"], "1x2")
    assert "cheat" not in feats and "elo_home" in feats


def test_run_backtest_synthetic_lr():
    res, audit = run_backtest(["btts"], ["lr"], df=_synthetic())
    assert "btts" in res and "lr" in res["btts"]
    m = res["btts"]["lr"]
    assert np.isfinite(m["logloss"]) and m["folds"] >= 1
    assert audit.get("all_embargo_ok") is True


def test_poisson_proba_valides():
    df = _synthetic()
    params = poisson_params(df.head(400))
    proba = poisson_predict(params, df.tail(20), "btts")
    assert proba.shape == (20, 2)
    assert ((proba >= 0) & (proba <= 1)).all()


def test_train_baselines_export_et_predict(tmp_path):
    # Phase 10 : entraîne sur synthétique, exporte, recharge, prédit.
    import joblib

    meta = train_baselines(["btts"], ["lr"], df=_synthetic(), out_dir=tmp_path)
    art = meta["markets"]["btts"]["lr"]
    assert art["n_features"] >= 1
    p = tmp_path / art["path"]
    assert p.exists()
    bundle = joblib.load(p)
    proba = bundle["model"].predict_proba(_synthetic().tail(5)[bundle["features"]].astype(float))
    assert proba.shape[1] == 2 and ((proba >= 0) & (proba <= 1)).all()

