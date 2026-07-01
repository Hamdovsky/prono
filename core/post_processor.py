"""
post_processor.py - Module 5: Confidence calibration, market generation, narrative, risk
Extracted from prediction_engine.py

Responsibilities:
- Strategic tactical narrative (brief)
- Poisson correct score calculation
- Power tube percentage calculation
- Value/Security/Tactical/H2H/Scoring insights
- Risk detection rules
- Market trap detection
- Confidence calibration layers
- Kelly Criterion stake calculation
"""

import math
import json

from data_loader import safe_float


# ============================================================================
# STRATEGIC BRIEF
# ============================================================================

def generate_strategic_brief(features, home_name, away_name, selection, match_obj=None):
    """Professional Strategic Tactical Narrative with referee/weather/absences context."""
    try:
        styles = {
            1: "Counter-attack eclair",
            2: "Patient possession",
            3: "Intensive pressing",
            4: "Direct/Long ball",
            5: "Regrouped defense",
            6: "Fast transition",
            0: "Standard balanced"
        }
        h_style = styles.get(int(features.get('h_style_enc', 0)), "Standard")
        a_style = styles.get(int(features.get('a_style_enc', 0)), "Standard")

        brief = f"Tactical Analysis: Opposition between {home_name} ({h_style}) and {away_name} ({a_style}). "

        mot = safe_float(features.get('motivation_context'), 1.0)
        if mot > 1.3:
            brief += "High intensity stake detected (Maximum pressure). "
        elif mot < 0.8:
            brief += "Match context with probable rotation/low stake. "

        ref_hwr = safe_float(features.get('referee_home_win_rate'), 0.45)
        if ref_hwr > 0.55:
            brief += "Referee statistically favorable to home advantage. "

        weather = str(features.get('weather_desc', '')).lower()
        if 'rain' in weather or 'snow' in weather:
            brief += "Adverse weather conditions potentially limiting game fluidity. "

        h_inj = safe_float(features.get('home_injury_impact'), 0)
        a_inj = safe_float(features.get('away_injury_impact'), 0)
        if h_inj >= 3.0:
            brief += f"Critical absence for {home_name} (Structural impact -15%). "
        if a_inj >= 3.0:
            brief += f"Critical absence for {away_name} (Structural impact -15%). "

        if selection == "Home":
            brief += f"Conclusion: Superiority in transitions for {home_name}."
        elif selection == "Away":
            brief += f"Conclusion: High breaking capacity for {away_name}."
        else:
            brief += "Conclusion: Tactical neutralization expected in midfield."

        return brief
    except Exception:
        return "Complex tactical analysis: Balance of forces present with multiple variables."


# ============================================================================
# POISSON CORRECT SCORE
# ============================================================================

def calculate_poisson_cs(xg_h, xg_a, top_n=3):
    """Calculate top N most likely exact scores from Poisson distribution."""
    from predictor import poisson_prob

    scores = []
    for h in range(7):
        for a in range(7):
            p = poisson_prob(xg_h, h) * poisson_prob(xg_a, a)
            scores.append({"score": f"{h}-{a}", "home": h, "away": a, "prob": round(p, 4)})
    scores.sort(key=lambda x: x['prob'], reverse=True)
    return scores[:top_n]


# ============================================================================
# POWER TUBES
# ============================================================================

def get_tube_pct(value, min_val=0.0, max_val=1.0):
    """Calculate percentage for power tube visualization."""
    clamped = max(min_val, min(max_val, value))
    return round(((clamped - min_val) / (max_val - min_val)) * 100) if max_val > min_val else 50


# ============================================================================
# RISK DETECTION
# ============================================================================

def detect_risk_flags(match_obj, features, p_h, p_d, p_a, league_tier):
    """
    7-point risk detection system.
    Returns (risk_score, risk_flags_list, veto_active).
    """
    risk_score = 0
    risk_flags = []

    # Rule 1: Tier 3 league
    if league_tier == 'T3':
        risk_score += 3
        risk_flags.append({"rule": "T3_LEAGUE", "impact": 3, "msg": "Tier 3 league - lower data quality"})

    # Rule 2: Dead Zone (no stake)
    h_dmf = features.get('home_dmf', 1.0)
    a_dmf = features.get('away_dmf', 1.0)
    if h_dmf < 0.9 and a_dmf < 0.9:
        risk_score += 4
        risk_flags.append({"rule": "DEAD_ZONE", "impact": 4, "msg": "Both teams low motivation"})

    # Rule 3: Motivation Collision (both desperate)
    if h_dmf > 2.0 and a_dmf > 2.0:
        risk_score += 2
        risk_flags.append({"rule": "MOTIVATION_COLLISION", "impact": 2, "msg": "Both teams extremely motivated - volatile"})

    # Rule 4: Steam Move (odds shifted significantly)
    odds_velocity = safe_float(features.get('odds_velocity', 0))
    if abs(odds_velocity) > 0.15:
        risk_score += 3
        risk_flags.append({"rule": "STEAM_MOVE", "impact": 3, "msg": f"Significant odds movement: {odds_velocity:.3f}"})

    # Rule 5: Missing data
    data_completeness = features.get('data_completeness', 100)
    if data_completeness < 50:
        risk_score += 5
        risk_flags.append({"rule": "MISSING_DATA", "impact": 5, "msg": f"Data completeness: {data_completeness:.0f}%"})

    # Rule 6: Integrity sentinel (suspicious draw pattern)
    if p_d > 0.35 and abs(p_h - p_a) < 0.05:
        risk_score += 2
        risk_flags.append({"rule": "INTEGRITY_SENTINEL", "impact": 2, "msg": "Suspiciously high draw with balanced teams"})

    # Rule 7: Frontend flags (user-reported)
    if match_obj.get('flagged_for_review'):
        risk_score += 5
        risk_flags.append({"rule": "FRONTEND_FLAG", "impact": 5, "msg": "Match flagged for review"})

    veto_active = risk_score >= 15
    if veto_active:
        risk_flags.append({"rule": "VETO_SYSTEM", "impact": 0, "msg": "VETO ACTIVE: Risk Score >= 15 - NO BET SHIELDED"})

    return risk_score, risk_flags, veto_active


# ============================================================================
# MARKET TRAP DETECTION
# ============================================================================

def detect_market_trap(features, p_h, p_a, momentum_h, momentum_a):
    """
    Detects market traps where odds movement contradicts momentum.
    Returns (trap_detected, trap_type, confidence_penalty).
    """
    odds_velocity = safe_float(features.get('odds_velocity', 0))
    h_inj = safe_float(features.get('home_injury_impact'), 0)
    a_inj = safe_float(features.get('away_injury_impact'), 0)

    # TRAP A: Home odds dropping but away team has momentum + negative news
    if odds_velocity < -0.08 and momentum_a > momentum_h and h_inj > 2.0:
        return True, "TRAP_A", 15.0

    # TRAP B: Away odds dropping but home team has momentum
    if odds_velocity > 0.08 and momentum_h > momentum_a and a_inj > 2.0:
        return True, "TRAP_B", 10.0

    return False, None, 0.0


# ============================================================================
# CONFIDENCE CALIBRATION LAYERS
# ============================================================================

CONF_TAG_ADJ = {
    "HIGH": 3.0,
    "MEDIUM": 0.0,
    "LOW": -8.0,
    "EXCLUDED": -100.0
}


def calibrate_confidence(base_confidence, league_tier, is_volatile, value_index,
                         motivation_level, data_completeness, has_lineups,
                         trap_detected, trap_penalty, no_history=False,
                         confidence_tag="MEDIUM"):
    """
    Multi-layer confidence calibration pipeline.
    Returns calibrated confidence percentage.
    """
    conf = base_confidence

    # Layer 1: League volatility penalty
    if league_tier == 'T3' or is_volatile:
        conf -= 20.0

    # Layer 2: Cap for volatile leagues
    if is_volatile:
        conf = min(conf, 64.5)

    # Layer 3: Value index bonus
    if value_index > 1.10:
        conf += 2.0

    # Layer 4: Motivation filter
    if motivation_level == "DEAD_ZONE":
        conf -= 10.0

    # Layer 5: No-history penalty (international teams)
    if no_history:
        conf -= 8.0

    # Layer 6: Reliability index (data + lineups)
    reliability = (data_completeness / 100.0) * 0.7 + (0.3 if has_lineups else 0.0)
    if reliability < 0.5:
        conf -= 5.0

    # Layer 7: Market trap penalty
    if trap_detected:
        conf -= trap_penalty

    # Layer 8: Confidence tag modulation
    conf += CONF_TAG_ADJ.get(confidence_tag, 0.0)

    return max(5.0, min(99.0, conf))


# ============================================================================
# KELLY CRITERION
# ============================================================================

def calculate_kelly_stake(confidence, odds, fraction=0.25):
    """
    Fractional Kelly Criterion for conservative stake sizing.
    fraction: default 0.25 (quarter Kelly).
    Returns stake as percentage of bankroll.
    """
    if odds <= 1.0 or confidence <= 0:
        return 0.0
    p = confidence / 100.0
    q = 1.0 - p
    kelly = ((p * (odds - 1)) - q) / (odds - 1)
    return max(0.0, round(kelly * fraction * 100, 2))


# ============================================================================
# VALUE INSIGHTS
# ============================================================================

def generate_value_insight(confidence, odds, model_prob):
    """Generate value betting insight."""
    if odds <= 1.0 or model_prob <= 0:
        return {"has_value": False, "msg": "Insufficient data for value analysis"}
    
    ev = model_prob * odds
    has_value = ev > 1.10
    
    return {
        "has_value": has_value,
        "ev": round(ev, 3),
        "edge": round((model_prob * odds - 1) * 100, 1),
        "msg": f"EV: {ev:.3f} - {'VALUE BET' if has_value else 'No value detected'}"
    }


def generate_security_insight(confidence, risk_score, data_completeness):
    """Generate security/reliability insight."""
    security_score = max(0, 100 - risk_score * 5 - (100 - data_completeness) * 0.3)
    
    if security_score > 80:
        level = "HIGH"
    elif security_score > 60:
        level = "MEDIUM"
    else:
        level = "LOW"
    
    return {
        "level": level,
        "score": round(security_score, 1),
        "msg": f"Security: {level} ({security_score:.0f}/100)"
    }
