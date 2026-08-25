"""Data Quality Score PAR MATCH (audit P0 — Phase 2).

Complète build/quality.py (rapport global source/ligue) par un score par ligne,
persisté dans le master : dq_<bloc> par famille de features, dq_coherence
(0/1 : cohérence interne de la ligne), dq_total ∈ [0,1].

Règle d'usage : une prédiction sur données pauvres doit être IDENTIFIÉE
comme telle (dq_total bas -> confiance réduite côté consommation).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd

BLOCKS: dict[str, list[str]] = {
    "identity": ["date", "league", "season", "home_team", "away_team"],
    "result": ["fthg", "ftag", "ftr"],
    "odds_1x2": ["odds_h_avg", "odds_d_avg", "odds_a_avg"],
    "odds_close_1x2": ["odds_h_close_avg", "odds_d_close_avg", "odds_a_close_avg"],
    "odds_ou25": ["odds_o25_avg", "odds_u25_avg"],
    "elo": ["elo_home", "elo_away"],
    "xg": ["home_xg", "away_xg", "home_xa", "away_xa"],
}

WEIGHTS: dict[str, float] = {
    "identity": 0.15,
    "result": 0.15,
    "odds_1x2": 0.15,
    "odds_close_1x2": 0.05,
    "odds_ou25": 0.05,
    "elo": 0.15,
    "xg": 0.20,
    "form": 0.10,
}

ELO_RANGE = (800.0, 2300.0)


def compute_dq(df: pd.DataFrame) -> pd.DataFrame:
    """Retourne un DataFrame aligné sur df.index avec les colonnes dq_*."""
    out = pd.DataFrame(index=df.index)

    # --- Complétude par bloc ---
    for name, cols in BLOCKS.items():
        cols_ok = [c for c in cols if c in df.columns]
        out[f"dq_{name}"] = (
            df[cols_ok].notna().mean(axis=1).round(4) if cols_ok else 0.0
        )
    form_cols = [c for c in df.columns if c.startswith(("H_", "A_")) and "_L" in c]
    out["dq_form"] = (
        df[form_cols].notna().mean(axis=1).round(4) if form_cols else 0.0
    )

    weighted = sum(
        out.get(f"dq_{k}", pd.Series(0.0, index=df.index)) * w
        for k, w in WEIGHTS.items()
    )

    # --- Cohérence interne de la ligne (0/1, pénalise dq_total) ---
    def _and(acc: pd.Series, cond: pd.Series) -> pd.Series:
        return acc * cond.astype(float)

    coherent = pd.Series(1.0, index=df.index)
    if {"fthg", "ftag"}.issubset(df.columns):
        coherent = _and(
            coherent,
            (df["fthg"].fillna(0) >= 0) & (df["ftag"].fillna(0) >= 0),
        )
        if "ftr" in df.columns:
            ftr_ok = (
                (df["ftr"].isin(["H", "D", "A"])) |
                df["ftr"].isna()
            )
            coherent = _and(coherent, ftr_ok)
            played = df["fthg"].notna() & df["ftag"].notna()
            derived = np.where(
                df["fthg"] > df["ftag"], "H",
                np.where(df["fthg"] == df["ftag"], "D", "A"),
            )
            mismatch = played & df["ftr"].isin(["H", "D", "A"]) & (derived != df["ftr"])
            coherent = _and(coherent, ~mismatch.fillna(False))
    if {"elo_home", "elo_away"}.issubset(df.columns):
        in_range = df["elo_home"].between(*ELO_RANGE) & df["elo_away"].between(*ELO_RANGE)
        coherent = _and(coherent, in_range | df["elo_home"].isna())
    for c in ("home_xg", "away_xg", "home_xa", "away_xa"):
        if c in df.columns:
            coherent = _and(coherent, df[c].fillna(0) >= 0)
    out["dq_coherence"] = coherent

    out["dq_total"] = (weighted * coherent).clip(0, 1).round(4)

    # --- Outliers signalés (informatif, ne casse pas le score) ---
    if {"home_xg", "away_xg"}.issubset(df.columns):
        m = df[["home_xg", "away_xg"]].stack().mean()
        s = df[["home_xg", "away_xg"]].stack().std()
        if s and s > 0:
            z = ((df["home_xg"] - m).abs() / s).fillna(0)
            out["dq_xg_outlier"] = (z > 5).astype(int)
        else:
            out["dq_xg_outlier"] = 0
    return out


def summarize(dq: pd.DataFrame) -> dict:
    return {
        "rows": int(len(dq)),
        "dq_mean": round(float(dq["dq_total"].mean()), 4),
        "below_0_8": int((dq["dq_total"] < 0.8).sum()),
        "incoherent": int((dq["dq_coherence"] == 0).sum()),
        "by_block": {
            c: round(float(dq[c].mean()), 4)
            for c in dq.columns
            if c.startswith("dq_") and c not in ("dq_total", "dq_coherence")
        },
    }


def write_availability(state_path, out_path) -> None:
    """Contrat anti-leakage v1 : horodatage de fraîcheur par bloc de sources."""
    state: dict = {}
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        state = {}
    payload = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "daily_ingest_asof": state.get("daily_last_run"),
        "xg_asof": state.get("fbref_last_run"),
        "elo_asof": state.get("daily_last_run"),
        "note": "Toute feature consommée doit être antérieure au kickoff du match prédit.",
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
