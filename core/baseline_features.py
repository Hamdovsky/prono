"""Feature store du fallback A/B (Phase 10 suite).

Reconstruit les 41 features de l'allowlist causale pour un match LIVE à partir
des signaux runtime disponibles (Elo, xG, cotes open) et impute la médiane
master pour le reste. Permet d'activer le fallback sur les matchs non encore
archivés dans master_dataset (historique seulement sinon).

Honnêteté : les features de forme L5/L10 et dérivés historiques sont médian-
imputées (prior sage) -> le fallback live est dégradé mais valide, pas fabriqué.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from core.backtest_walkforward import FEATURE_ALLOWLIST

ROOT = Path(__file__).resolve().parents[1]
MASTER_CSV = ROOT / "data_pipeline" / "data" / "processed" / "master_dataset.csv"

_medians: dict = {}


def medians() -> dict:
    global _medians
    if not _medians:
        df = pd.read_csv(MASTER_CSV)
        cols = [c for c in FEATURE_ALLOWLIST if c in df.columns]
        _medians = df[cols].median(numeric_only=True).to_dict()
    return _medians


def build(ctx: dict | None) -> dict:
    """Renvoie un dict feature->valeur aligné sur FEATURE_ALLOWLIST.

    ctx attend les clés optionnelles : elo_h, elo_a, xg_h, xg_a,
    P1_open, PX_open, P2_open, odds_h, odds_d, odds_a.
    """
    m = medians()
    feats = {f: (m.get(f, 0.0) if pd.notna(m.get(f)) else 0.0) for f in FEATURE_ALLOWLIST}
    if not ctx:
        return feats
    if ctx.get("elo_h") is not None:
        feats["elo_home"] = float(ctx["elo_h"])
    if ctx.get("elo_a") is not None:
        feats["elo_away"] = float(ctx["elo_a"])
    if ctx.get("elo_h") is not None and ctx.get("elo_a") is not None:
        feats["F_Elo_Diff"] = float(ctx["elo_h"]) - float(ctx["elo_a"])
    if ctx.get("xg_h") is not None:
        feats["home_xg"] = float(ctx["xg_h"])
    if ctx.get("xg_a") is not None:
        feats["away_xg"] = float(ctx["xg_a"])
    for src, dst in (
        ("P1_open", "P1_open_avg"),
        ("PX_open", "PX_open_avg"),
        ("P2_open", "P2_open_avg"),
        ("odds_h", "odds_h_avg"),
        ("odds_d", "odds_d_avg"),
        ("odds_a", "odds_a_avg"),
    ):
        if ctx.get(src) is not None:
            feats[dst] = float(ctx[src])
    return feats
