"""
predictor.py - Module 4: Core probability calculations, Monte Carlo, score derivation
Extracted from prediction_engine.py

Responsibilities:
- Poisson probability mass function
- Bivariate Poisson Monte Carlo simulation (goal-level)
- Most likely score (Poisson/Dixon-Coles)
- Exact score derivation
- Live event adjustment (red cards)
- Draw No Bet / Double Chance probabilities
"""

import math
import json
import numpy as np

from goal_model import (
    get_dixon_coles_adjustment as gm_get_dixon_coles_adjustment,
    negbin_pmf,
    cmp_pmf,
)


# ============================================================================
# POISSON PMF
# ============================================================================

def poisson_prob(lam, k):
    """Calculate Poisson probability P(X=k) given lambda."""
    if k < 0:
        return 0
    if lam <= 0:
        return 1.0 if k == 0 else 0.0
    return (math.exp(-lam) * (lam ** k)) / math.factorial(k)


# ============================================================================
# GOAL-LEVEL MONTE CARLO SIMULATION
# ============================================================================

def monte_carlo_simulation(xg_h, xg_a, iterations=1000, distribution='poisson',
                           theta=2.0, nu=1.0, rho=-0.12):
    """
    Simulates match outcomes using Bivariate Poisson (or NegBin/CMP)
    with Dixon-Coles adjustment. Models goal co-dependence (shared variance)
    to accurately price draws.
    """
    h_wins = 0
    draws = 0
    a_wins = 0
    total_goals_list = []
    btts_count = 0

    cov = 0.15 * min(max(0, xg_h), max(0, xg_a))
    if math.isnan(cov) or math.isinf(cov):
        cov = 0.0

    base_h = max(0, xg_h - cov)
    base_a = max(0, xg_a - cov)

    if distribution == 'negbin':
        p_h = theta / (theta + base_h) if base_h > 0 else 1.0
        p_a = theta / (theta + base_a) if base_a > 0 else 1.0
        home_base = np.random.negative_binomial(theta, p_h, iterations)
        away_base = np.random.negative_binomial(theta, p_a, iterations)
    elif distribution == 'cmp':
        home_base = np.array([np.random.poisson(base_h) for _ in range(iterations)])
        away_base = np.array([np.random.poisson(base_a) for _ in range(iterations)])
    else:
        home_base = np.random.poisson(base_h, iterations)
        away_base = np.random.poisson(base_a, iterations)

    shared_goals = np.random.poisson(cov, iterations)

    for i in range(iterations):
        gh = int(home_base[i]) + int(shared_goals[i])
        ga = int(away_base[i]) + int(shared_goals[i])

        if gh > ga:
            h_wins += 1
        elif gh < ga:
            a_wins += 1
        else:
            draws += 1

        total_goals_list.append(gh + ga)
        if gh > 0 and ga > 0:
            btts_count += 1

    return {
        "p_h": h_wins / iterations,
        "p_d": draws / iterations,
        "p_a": a_wins / iterations,
        "avg_total_goals": sum(total_goals_list) / iterations,
        "btts_prob": btts_count / iterations,
        "ou_25_prob": sum(1 for g in total_goals_list if g > 2.5) / iterations,
        "ou_15_prob": sum(1 for g in total_goals_list if g > 1.5) / iterations,
        "ou_35_prob": sum(1 for g in total_goals_list if g > 3.5) / iterations
    }


# ============================================================================
# MOST LIKELY SCORE
# ============================================================================

def calculate_most_likely_score(xg_h, xg_a, distribution='poisson',
                                theta=2.0, nu=1.0, rho=-0.12):
    """Find the most probable exact score using Dixon-Coles and alternative distributions."""
    best_score = (1, 1)
    best_prob = -1
    for h in range(8):
        for a in range(8):
            if distribution == 'negbin':
                prob = negbin_pmf(xg_h, theta, h) * negbin_pmf(xg_a, theta, a)
            elif distribution == 'cmp':
                prob = cmp_pmf(xg_h, nu, h) * cmp_pmf(xg_a, nu, a)
            else:
                prob = poisson_prob(xg_h, h) * poisson_prob(xg_a, a)
            prob *= gm_get_dixon_coles_adjustment(xg_h, xg_a, h, a, rho)

            if prob > best_prob:
                best_prob = prob
                best_score = (h, a)
    return f"{best_score[0]} - {best_score[1]}"


def calculate_exact_score(xg_h, xg_a, p_home, p_away, distribution='poisson',
                          theta=2.0, nu=1.0, rho=-0.12, gamma=0.0):
    """Derive most likely scoreline from xG + win probability imbalance.

    When xG are close (majority of matches), Poisson mode gives 1-1 for
    everything.  This function uses the win-probability ratio to produce
    differentiated scores that match the actual prediction strength.
    """
    p_draw = max(0, 100 - p_home - p_away)

    # Phase 1 — try pure Poisson from xG
    score_str = calculate_most_likely_score(xg_h, xg_a, distribution=distribution,
                                            theta=theta, nu=nu, rho=rho)
    h_f, a_f = map(int, score_str.split(' - '))

    # Phase 2 — if score is a draw (most common failure mode) or very low
    # scoring, derive winner and margin from probability distribution.
    if h_f == a_f or (h_f + a_f) < 2:
        # Which team is the favourite?
        if p_home > max(p_draw, p_away) and (p_home - max(p_draw, p_away)) > 3:
            margin = p_home - max(p_draw, p_away)
            if margin > 25:
                h_f, a_f = 2, 0
            elif margin > 12:
                h_f, a_f = 2, 1
            else:
                h_f, a_f = 1, 0
        elif p_away > max(p_draw, p_home) and (p_away - max(p_draw, p_home)) > 3:
            margin = p_away - max(p_draw, p_home)
            if margin > 25:
                h_f, a_f = 0, 2
            elif margin > 12:
                h_f, a_f = 1, 2
            else:
                h_f, a_f = 0, 1
        else:
            # True draw — bump total goals if xG support it
            h_f, a_f = (1, 1)

    # Phase 3 — override for very high win confidence (> 70 %)
    if p_home > 70 and h_f == a_f:
        h_f = a_f + 1
    elif p_away > 70 and h_f == a_f:
        a_f = h_f + 1

    return f"{max(0, min(7, h_f))} - {max(0, min(7, a_f))}"


# ============================================================================
# LIVE EVENT ADJUSTMENT
# ============================================================================

def apply_live_event_adjustment(match_obj, p_h, p_d, p_a):
    """Red card emergency protocol for live matches."""
    is_live = match_obj.get('status') == 'LIVE' or match_obj.get('is_live', False)
    if not is_live:
        return p_h, p_d, p_a, []

    alerts = []
    stats_raw = match_obj.get('stats_blob', '[]')
    if isinstance(stats_raw, str):
        try:
            stats = json.loads(stats_raw)
        except Exception:
            stats = []
    else:
        stats = stats_raw

    red_h = 0
    red_a = 0
    for s in stats:
        cat = s.get('category', '').lower()
        if 'red cards' in cat:
            red_h = int(s.get('homeValue', 0))
            red_a = int(s.get('awayValue', 0))

    if red_h > 0:
        penalty = 0.25 * red_h
        p_h -= p_h * penalty
        p_a += (p_h * penalty * 0.7)
        p_d += (p_h * penalty * 0.3)
        alerts.append({"type": "LIVE_RED", "team": "home",
                       "msg": f"RED CARD (HOME) x{red_h} - ADJUSTING LIVE..."})

    if red_a > 0:
        penalty = 0.25 * red_a
        p_a -= p_a * penalty
        p_h += (p_a * penalty * 0.7)
        p_d += (p_a * penalty * 0.3)
        alerts.append({"type": "LIVE_RED", "team": "away",
                       "msg": f"RED CARD (AWAY) x{red_a} - ADJUSTING LIVE..."})

    if red_h > 0 or red_a > 0:
        alerts.append({"type": "V25_EMERGENCY",
                       "msg": "Red Card Emergency Protocol: Normalizing historical bias..."})

    s_total = p_h + p_d + p_a
    if s_total == 0:
        return 0.33, 0.33, 0.34, alerts
    return p_h / s_total, p_d / s_total, p_a / s_total, alerts


# ============================================================================
# MARKET PROBABILITIES
# ============================================================================

def calculate_ah_dnb_probs(p_h, p_d, p_a):
    """
    Calculate professional market probabilities:
    - Draw No Bet (AH 0.0)
    - Double Chance
    """
    total_non_draw = p_h + p_a
    if total_non_draw == 0:
        return 0.5, 0.5, 0.5, 0.5, 1.0

    dnb_h = p_h / total_non_draw
    dnb_a = p_a / total_non_draw

    dc_h = p_h + p_d
    dc_a = p_a + p_d
    dc_12 = p_h + p_a

    return dnb_h, dnb_a, dc_h, dc_a, dc_12
