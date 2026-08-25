"""Feature store du fallback A/B (Phase 10 suite).

Reconstruit les 41 features de l'allowlist causale pour un match LIVE à partir
des signaux runtime disponibles (Elo, xG, cotes open) + FORMES L5/L10 roulantes
calculées depuis master_dataset (matches strictement antérieurs à la date du
match -> aucune fuite). Le reste (features absentes) est médian-imputé.

Honnêteté : les formes live sont DÉRIVÉES de l'historique réel (pas fabriquées) ;
seules les features non calculables sont médian-imputées.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from core.backtest_walkforward import FEATURE_ALLOWLIST

ROOT = Path(__file__).resolve().parents[1]
MASTER_CSV = ROOT / "data_pipeline" / "data" / "processed" / "master_dataset.csv"

_medians: dict = {}
_master: pd.DataFrame | None = None


def medians() -> dict:
    global _medians
    if not _medians:
        df = _master_df()
        cols = [c for c in FEATURE_ALLOWLIST if c in df.columns]
        _medians = df[cols].median(numeric_only=True).to_dict()
    return _medians


def _master_df() -> pd.DataFrame:
    global _master
    if _master is None:
        _master = pd.read_csv(MASTER_CSV)
        _master["date"] = pd.to_datetime(_master["date"])
    return _master


def _team_rolling(team: str, as_of: pd.Timestamp, df: pd.DataFrame) -> dict | None:
    sub = df[((df["home_team"] == team) | (df["away_team"] == team)) & (df["date"] < as_of)]
    if sub.empty:
        return None
    sub = sub.sort_values("date")
    rows = []
    for _, r in sub.iterrows():
        home = r["home_team"] == team
        gf = r["fthg"] if home else r["ftag"]
        ga = r["ftag"] if home else r["fthg"]
        xgf = r.get("home_xg") if home else r.get("away_xg")
        xga = r.get("away_xg") if home else r.get("home_xg")
        shf = r.get("hs") if home else r.get("as")
        sha = r.get("as") if home else r.get("hs")
        res = 3 if gf > ga else (1 if gf == ga else 0)
        rows.append((float(gf), float(ga), _num(xgf), _num(xga), _num(shf), _num(sha), res))

    def agg(n):
        s = rows[-n:]
        has = lambda i: any(r[i] is not None for r in s)
        mean = lambda i: (sum(r[i] for r in s if r[i] is not None) / sum(1 for r in s if r[i] is not None)) if has(i) else None
        return {
            "pts": sum(r[6] for r in s) / n,
            "gf": mean(0), "ga": mean(1),
            "xg": mean(2), "xga": mean(3),
            "sh": mean(4), "sha": mean(5),
        }

    return {"L5": agg(5), "L10": agg(10)}


def _num(v):
    try:
        return float(v) if pd.notna(v) else None
    except Exception:
        return None


def build(ctx: dict | None) -> dict:
    """Renvoie un dict feature->valeur aligné sur FEATURE_ALLOWLIST.

    ctx (optionnel) : elo_h, elo_a, xg_h, xg_a, P1_open, PX_open, P2_open,
    odds_h, odds_d, odds_a, home_team, away_team, date (str/Timestamp).
    """
    m = medians()
    feats = {f: (m.get(f, 0.0) if pd.notna(m.get(f)) else 0.0) for f in FEATURE_ALLOWLIST}
    if not ctx:
        return feats

    # Signaux runtime directs
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
        ("P1_open", "P1_open_avg"), ("PX_open", "PX_open_avg"), ("P2_open", "P2_open_avg"),
        ("odds_h", "odds_h_avg"), ("odds_d", "odds_d_avg"), ("odds_a", "odds_a_avg"),
    ):
        if ctx.get(src) is not None:
            feats[dst] = float(ctx[src])
    # Absences (Phase 9) : valeur live si fournie, sinon mediane (=0 historique).
    # Gated : aucun effet tant que le scraping live ne fournit pas la donnee.
    if ctx.get("absence_impact") is not None:
        feats["absence_impact_pondéré"] = float(ctx["absence_impact"])

    # Formes L5/L10 roulantes depuis master_dataset (strictement antérieures)
    ht, at, dt = ctx.get("home_team"), ctx.get("away_team"), ctx.get("date")
    if ht and at:
        as_of = pd.to_datetime(dt) if dt else pd.Timestamp.utcnow()
        df = _master_df()
        h, a = _team_rolling(ht, as_of, df), _team_rolling(at, as_of, df)
        if h and a:
            for win, src in (("H_", h), ("A_", a)):
                feats[f"{win}pts_L5"] = src["L5"]["pts"]
                feats[f"{win}pts_L10"] = src["L10"]["pts"]
                feats[f"{win}gf_L5"] = src["L5"]["gf"] or 0.0
                feats[f"{win}gf_L10"] = src["L10"]["gf"] or 0.0
                feats[f"{win}ga_L5"] = src["L5"]["ga"] or 0.0
                feats[f"{win}ga_L10"] = src["L10"]["ga"] or 0.0
                feats[f"{win}xg_L5"] = src["L5"]["xg"] or 0.0
                feats[f"{win}xg_L10"] = src["L10"]["xg"] or 0.0
                feats[f"{win}xga_L5"] = src["L5"]["xga"] or 0.0
                feats[f"{win}xga_L10"] = src["L10"]["xga"] or 0.0
                feats[f"{win}shots_L5"] = src["L5"]["sh"] or 0.0
                feats[f"{win}shots_L10"] = src["L10"]["sh"] or 0.0
            hxg = h["L5"]["xg"] or 0.0
            axg = a["L5"]["xg"] or 0.0
            feats["Total_xG_L5"] = hxg + axg
            feats["Form_Diff_L5"] = h["L5"]["pts"] - a["L5"]["pts"]
    return feats
