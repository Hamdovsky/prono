"""poisson_model.py — Modèle Poisson pour calculer les probabilités de marché.

Calcule P(BTTS), P(Over/Under), P(1X2), P(DoubleChance) depuis xG ou historique.
Marqué bookmaker=false (MODEL ESTIMATE).

Formules :
  - P(BTTS)  = 1 - P(0 home) * P(0 away)
  - P(Over 2.5) = 1 - P(0 total) - P(1 total)
  - P(1X2)   = softmax Poisson log-probs
  - Margin overround = 1.06 (bookmaker simulé)
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np
import pandas as pd
from scipy.stats import poisson

from util import get_logger

log = get_logger("poisson_model")

OVERROUND = 1.06


def _poisson_pmf(k: int, lam: float) -> float:
    if lam <= 0:
        return 1.0 if k == 0 else 0.0
    try:
        return math.exp(poisson.logpmf(k, lam))
    except Exception:
        return 0.0


def _fair_odds(p: float) -> float:
    if p <= 0 or p > 1:
        return 999.0
    return 1.0 / p


def estimate_lambda_from_xg(xg: float, home_adv: float = 0.0) -> float:
    base = max(0.1, xg)
    return base + home_adv


def estimate_lambda_from_history(df: pd.DataFrame, team: str, is_home: bool,
                                n_games: int = 10) -> float:
    if df is None or df.empty:
        return 1.35
    col_team = "home_team" if is_home else "away_team"
    col_gf = "home_score" if is_home else "away_score"
    col_ga = "away_score" if is_home else "home_score"
    subset = df[df[col_team] == team].sort_values("date", ascending=False).head(n_games)
    if subset.empty:
        return 1.35
    return float(max(0.1, subset[col_gf].mean()))


def compute_btts(home_lambda: float, away_lambda: float) -> float:
    p0h = _poisson_pmf(0, home_lambda)
    p0a = _poisson_pmf(0, away_lambda)
    return 1.0 - (p0h * p0a)


def compute_over_under(total_lambda: float, line: float = 2.5) -> tuple[float, float]:
    total_lambda = max(0.0, total_lambda)
    p_under = sum(_poisson_pmf(k, total_lambda) for k in range(int(line) + 1))
    p_over = 1.0 - p_under
    return max(0.0, min(1.0, p_over)), max(0.0, min(1.0, p_under))


def compute_1x2_from_xg(home_lambda: float, away_lambda: float) -> tuple[float, float, float]:
    probs = []
    for home_goals in range(10):
        for away_goals in range(10):
            p = _poisson_pmf(home_goals, home_lambda) * _poisson_pmf(away_goals, away_lambda)
            if home_goals > away_goals:
                probs.append(("H", p))
            elif home_goals < away_goals:
                probs.append(("A", p))
            else:
                probs.append(("D", p))
    pH = sum(p for label, p in probs if label == "H")
    pD = sum(p for label, p in probs if label == "D")
    pA = sum(p for label, p in probs if label == "A")
    total = pH + pD + pA
    if total > 0:
        pH, pD, pA = pH / total, pD / total, pA / total
    return max(0.0, min(1.0, pH)), max(0.0, min(1.0, pD)), max(0.0, min(1.0, pA))


def apply_margin(pH: float, pD: float, pA: float, margin: float = OVERROUND) -> tuple[float, float, float]:
    total_inv = pH + pD + pA
    if total_inv <= 0:
        return 999.0, 999.0, 999.0
    inv = (1.0 / (pH / total_inv) + 1.0 / (pD / total_inv) + 1.0 / (pA / total_inv)) / 3.0
    scale = (margin - 1.0) / (inv - 1.0) if inv != 1.0 else 1.0
    scale = max(0.5, min(2.0, scale))
    adj = 1.0 + scale * (margin - 1.0)
    return 1.0 / (pH * adj), 1.0 / (pD * adj), 1.0 / (pA * adj)


def compute_market_odds(home_xg: float, away_xg: float,
                       home_adv: float = 0.1,
                       ou_line: float = 2.5) -> dict:
    home_lam = estimate_lambda_from_xg(home_xg, home_adv)
    away_lam = estimate_lambda_from_xg(away_xg, -home_adv * 0.5)
    total_lam = home_lam + away_lam
    pH, pD, pA = compute_1x2_from_xg(home_lam, away_lam)
    oH, oD, oA = apply_margin(pH, pD, pA)
    p_over, p_under = compute_over_under(total_lam, ou_line)
    o_over = _fair_odds(p_over)
    o_under = _fair_odds(p_under)
    p_btts = compute_btts(home_lam, away_lam)
    o_btts_yes = _fair_odds(p_btts)
    o_btts_no = _fair_odds(1.0 - p_btts)
    return {
        "home_xg": home_xg, "away_xg": away_xg,
        "home_lambda": home_lam, "away_lambda": away_lam,
        "p_home_win": round(pH, 4), "p_draw": round(pD, 4), "p_away_win": round(pA, 4),
        "odds_home": round(oH, 2), "odds_draw": round(oD, 2), "odds_away": round(oA, 2),
        "p_over": round(p_over, 4), "p_under": round(p_under, 4),
        "odds_over": round(o_over, 2), "odds_under": round(o_under, 2),
        "p_btts_yes": round(p_btts, 4), "p_btts_no": round(1.0 - p_btts, 4),
        "odds_btts_yes": round(o_btts_yes, 2), "odds_btts_no": round(o_btts_no, 2),
        "bookmaker": False,
        "type": "MODEL_ESTIMATE",
    }


def compute_from_historical_df(df: pd.DataFrame, home_team: str, away_team: str,
                               n_games: int = 10, ou_line: float = 2.5) -> dict:
    home_xg = estimate_lambda_from_history(df, home_team, is_home=True, n_games=n_games)
    away_xg = estimate_lambda_from_history(df, away_team, is_home=False, n_games=n_games)
    return compute_market_odds(home_xg, away_xg, ou_line=ou_line)
