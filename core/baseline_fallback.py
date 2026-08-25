"""Fallback A/B des baselines walk-forward dans le runtime FastAPI (Phase 10 suite).

Charge les artefacts `models/baseline_{lr,rf}_{market}.pkl` (entraînés sur
l'allowlist causale par `core.backtest_walkforward.train_baselines`) et les
applique à un match si ses features allowlist sont disponibles.

Kill-switch : ne s'active QUE si BASELINE_FALLBACK=on. Par défaut OFF -> aucun
impact sur la prod. Pour les matchs absents de master_dataset (futurs non encore
archivés), renvoie None (pas de feature store live -> voir CHANGELOG).
"""
from __future__ import annotations

import os

import joblib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = ROOT / "models"
MASTER_CSV = ROOT / "data_pipeline" / "data" / "processed" / "master_dataset.csv"

# Modèles RETENUS (BASELINE_EVAL) : LR pour 1X2+O/U2.5, RF pour BTTS.
MODEL_FOR_MARKET = {"1x2": "lr", "ou25": "lr", "btts": "rf"}

_cache: dict = {}


def _norm(s):
    return str(s or "").strip().lower().replace("-", " ").replace("  ", " ")


def _index():
    if "idx" in _cache:
        return _cache["idx"]
    import pandas as pd

    df = pd.read_csv(MASTER_CSV)
    idx = {}
    lg = df["league"].astype(str)
    h = df["home_team"].astype(str)
    a = df["away_team"].astype(str)
    d = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
    for i in range(len(df)):
        key = (_norm(lg.iloc[i]), _norm(h.iloc[i]), _norm(a.iloc[i]), d.iloc[i])
        idx[key] = df.iloc[i]
    _cache["idx"] = idx
    return idx


def _match_key(match: dict):
    date = match.get("date")
    if date is None and match.get("startTimestamp"):
        import pandas as pd

        date = pd.to_datetime(int(match["startTimestamp"]), unit="s").strftime("%Y-%m-%d")
    return (
        _norm(match.get("league")),
        _norm(match.get("home_team")),
        _norm(match.get("away_team")),
        str(date)[:10] if date else None,
    )


def predict_for_match(match: dict, markets=("1x2", "ou25", "btts")) -> dict | None:
    """Renvoie {market: [p_home, p_draw, p_away] | [p_no, p_yes]} ou None si
    match inconnu de master_dataset (kill-switch already géré par l'appelant)."""
    if not match:
        return None
    row = _index().get(_match_key(match))
    if row is None:
        return None
    try:
        from core.backtest_walkforward import FEATURE_ALLOWLIST
    except Exception:
        return None
    out = {}
    for m in markets:
        model = MODEL_FOR_MARKET.get(m)
        if not model:
            continue
        pkl = MODELS_DIR / f"baseline_{model}_{m}.pkl"
        if not pkl.exists():
            continue
        try:
            bundle = joblib.load(pkl)
            feats = bundle["features"]
            x = [float(row.get(f)) if pd_notna(row.get(f)) else 0.0 for f in feats]
            proba = bundle["model"].predict_proba([x])[0]
            out[m] = [round(float(p), 5) for p in proba]
        except Exception:
            continue
    return out or None


def pd_notna(v):
    try:
        import pandas as pd

        return bool(pd.notna(v))
    except Exception:
        return v is not None


def is_enabled() -> bool:
    return os.environ.get("BASELINE_FALLBACK", "off").lower() == "on"
