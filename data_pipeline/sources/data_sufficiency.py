"""data_sufficiency.py — Data Sufficiency Score par marché.

Mesure la QUALITÉ des données disponibles pour chaque prédiction de marché
(1X2, Over/Under, BTTS, Corners, Cards).

≠ Prediction Confidence (confiance statistique dans la prédiction elle-même).
= Data Sufficiency (qualité brute des données en entrée).

BLUE BAND = quand le Data Sufficiency Score est assez élevé pour
afficher une prédiction fiable. Chaque marché a son propre score.

Scoring (0-100) :
  1. Historical depth  (0-30) — matchs récents disponibles pour les 2 équipes
  2. H2H coverage    (0-20) — historique H2H disponible
  3. xG data        (0-25) — xG réel vs modélisé vs absent
  4. Form data      (0-15) — L3/L5/L10 disponibles
  5. Source diversity (0-10) — nombre de sources indépendantes

Blue Band thresholds :
  >= 75 : HIGH_SUFFICIENCY  → BLUE BAND displayed
  50-74: MEDIUM_SUFFICIENCY → BLUE BAND with warning
  < 50 : LOW_SUFFICIENCY    → NO BLUE BAND (no prediction)
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import pandas as pd

from util import get_logger

log = get_logger("data_sufficiency")


class SufficiencyLevel(Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


@dataclass
class MarketSufficiency:
    market: str
    score: float
    level: SufficiencyLevel
    blue_band: bool
    reasons: list[str]
    details: dict


def _score_historical_depth(df: pd.DataFrame, home_team: str, away_team: str,
                            n_days: int = 365) -> tuple[int, list[str]]:
    if df is None or df.empty:
        return 0, ["No historical data available"]
    cutoff = pd.Timestamp.now() - pd.Timedelta(days=n_days)
    home_matches = df[
        (df["home_team"] == home_team) | (df["away_team"] == home_team)
    ]
    away_matches = df[
        (df["home_team"] == away_team) | (df["away_team"] == away_team)
    ]
    home_recent = home_matches[home_matches["date"] >= cutoff] if "date" in df.columns else home_matches
    away_recent = away_matches[away_matches["date"] >= cutoff] if "date" in df.columns else away_matches
    h_n = len(home_recent)
    a_n = len(away_recent)
    reasons = []
    score = 0
    if h_n == 0 or a_n == 0:
        score = 0
        reasons.append(f"Insufficient match history (home={h_n}, away={a_n})")
    elif h_n <= 2 or a_n <= 2:
        score = 5
        reasons.append(f"Very few recent matches (home={h_n}, away={a_n})")
    elif h_n <= 5 or a_n <= 5:
        score = 15
        reasons.append(f"Few recent matches (home={h_n}, away={a_n})")
    elif h_n <= 10 or a_n <= 10:
        score = 25
        reasons.append(f"Moderate match history (home={h_n}, away={a_n})")
    else:
        score = 30
        reasons.append(f"Good match history (home={h_n}, away={a_n})")
    return score, reasons


def _score_h2h(df: pd.DataFrame, home_team: str, away_team: str) -> tuple[int, list[str]]:
    if df is None or df.empty:
        return 0, ["No H2H data"]
    h2h = df[
        ((df["home_team"] == home_team) & (df["away_team"] == away_team)) |
        ((df["home_team"] == away_team) & (df["away_team"] == home_team))
    ]
    n = len(h2h)
    if n == 0:
        return 0, ["No H2H matches found"]
    elif n <= 2:
        return 5, [f"Very few H2H matches ({n})"]
    elif n <= 5:
        return 12, [f"Few H2H matches ({n})"]
    else:
        return 20, [f"Good H2H coverage ({n} matches)"]


def _score_xg(data_sources: dict) -> tuple[int, list[str]]:
    has_statsbomb = data_sources.get("statsbomb_open_data", False)
    has_fbref = data_sources.get("fbref", False)
    has_modeled = data_sources.get("modeled_xg", False)
    if has_statsbomb:
        return 25, ["xG from StatsBomb (real tracking data)"]
    elif has_fbref:
        return 20, ["xG from FBref (real tracking data)"]
    elif has_modeled:
        return 8, ["xG modeled from historical goals"]
    else:
        return 0, ["No xG data available"]


def _score_form(form_df: pd.DataFrame, team: str, window: int = 5) -> tuple[int, bool]:
    if form_df is None or form_df.empty:
        return 0, False
    tf = form_df[form_df["team"] == team]
    if tf.empty:
        return 0, False
    col = f"form_{window}"
    if col not in tf.columns:
        return 0, False
    has_data = tf[col].notna().sum() > 0
    if not has_data:
        return 0, False
    return min(15, max(5, int(tf[col].iloc[0] / 3))), True


def _score_source_diversity(sources: list[str]) -> tuple[int, list[str]]:
    n = len(sources)
    if n >= 3:
        return 10, [f"{n} independent sources"]
    elif n == 2:
        return 6, [f"{n} sources available"]
    elif n == 1:
        return 3, ["Single source available"]
    else:
        return 0, ["No data sources"]


def compute_market_sufficiency(
    market: str,
    home_team: str,
    away_team: str,
    historical_df: pd.DataFrame = None,
    h2h_df: pd.DataFrame = None,
    form_df: pd.DataFrame = None,
    data_sources: dict = None,
    sources_used: list[str] = None,
) -> MarketSufficiency:
    if data_sources is None:
        data_sources = {}
    if sources_used is None:
        sources_used = []
    reasons = []
    score = 0

    if market in ("1X2", "double_chance"):
        h_score, h_reasons = _score_historical_depth(historical_df, home_team, away_team)
        h2h_score, h2h_reasons = _score_h2h(h2h_df, home_team, away_team)
        xg_score, xg_reasons = _score_xg(data_sources)
        score = h_score + h2h_score + xg_score
        reasons.extend(h_reasons)
        reasons.extend(h2h_reasons)
        reasons.extend(xg_reasons)
        # Form for 1X2
        form_score_home, has_form_home = (_score_form(form_df, home_team, 5))
        form_score_away, has_form_away = (_score_form(form_df, away_team, 5))
        if has_form_home or has_form_away:
            form_bonus = (form_score_home + form_score_away) // 2
            score += min(15, form_bonus)
            reasons.append(f"Form data available (bonus: {form_bonus})")
        else:
            reasons.append("No form data")

    elif market in ("over_under", "over_under_2_5", "o25", "u25"):
        h_score, h_reasons = _score_historical_depth(historical_df, home_team, away_team, n_days=180)
        h2h_score, h2h_reasons = _score_h2h(h2h_df, home_team, away_team)
        xg_score, xg_reasons = _score_xg(data_sources)
        score = h_score + h2h_score + xg_score
        reasons.extend(h_reasons)
        reasons.extend(h2h_reasons)
        reasons.extend(xg_reasons)
        if data_sources.get("modeled_xg"):
            score += 10
            reasons.append("Poisson model can compute OU from goals history")

    elif market in ("btts", "both_teams_to_score"):
        h_score, h_reasons = _score_historical_depth(historical_df, home_team, away_team, n_days=180)
        h2h_score, h2h_reasons = _score_h2h(h2h_df, home_team, away_team)
        xg_score, xg_reasons = _score_xg(data_sources)
        score = h_score + h2h_score + xg_score
        reasons.extend(h_reasons)
        reasons.extend(h2h_reasons)
        reasons.extend(xg_reasons)
        if data_sources.get("modeled_xg"):
            score += 10
            reasons.append("Poisson model can compute BTTS from goals history")

    elif market in ("corners", "cards"):
        h_score, h_reasons = _score_historical_depth(historical_df, home_team, away_team, n_days=90)
        h2h_score, h2h_reasons = _score_h2h(h2h_df, home_team, away_team)
        xg_score, xg_reasons = _score_xg(data_sources)
        score = h_score + h2h_score + xg_score
        reasons.extend(h_reasons)
        reasons.extend(h2h_reasons)
        reasons.extend(xg_reasons)
        reasons.append("Corners/Cards data from football-data.co.uk if available")

    else:
        h_score, h_reasons = _score_historical_depth(historical_df, home_team, away_team)
        h2h_score, h2h_reasons = _score_h2h(h2h_df, home_team, away_team)
        xg_score, xg_reasons = _score_xg(data_sources)
        score = h_score + h2h_score + xg_score
        reasons.extend(h_reasons)
        reasons.extend(h2h_reasons)
        reasons.extend(xg_reasons)

    div_score, div_reasons = _score_source_diversity(sources_used)
    score += div_score
    reasons.extend(div_reasons)

    score = min(100, max(0, score))

    if score >= 75:
        level = SufficiencyLevel.HIGH
        blue_band = True
    elif score >= 50:
        level = SufficiencyLevel.MEDIUM
        blue_band = True
    else:
        level = SufficiencyLevel.LOW
        blue_band = False

    return MarketSufficiency(
        market=market,
        score=score,
        level=level,
        blue_band=blue_band,
        reasons=reasons,
        details={
            "historical_score": h_score,
            "h2h_score": h2h_score,
            "xg_score": xg_score,
            "source_diversity_score": div_score,
        },
    )


def get_all_market_sufficiencies(
    home_team: str,
    away_team: str,
    historical_df: pd.DataFrame = None,
    h2h_df: pd.DataFrame = None,
    form_df: pd.DataFrame = None,
    data_sources: dict = None,
    sources_used: list[str] = None,
) -> dict[str, MarketSufficiency]:
    markets = ["1X2", "over_under", "btts", "corners", "cards"]
    return {
        m: compute_market_sufficiency(
            m, home_team, away_team,
            historical_df, h2h_df, form_df, data_sources, sources_used
        )
        for m in markets
    }
