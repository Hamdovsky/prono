"""
xg_engine.py — Multi-source xG Computation & Modifier Pipeline
Extracted from prediction_engine.py (Lines 228-541)

Responsibilities:
  1. Compute base xG from 4 sources (raw, avg, odds-reverse, historical)
  2. Apply tactical style, time machine, news/squad, DMF, market, environmental modifiers
  3. Apply Dixon-Coles gamma correction
  4. Cascade guard (cap cumulative modifiers)
"""
import math
import json
import sys
import numpy as np

from goal_model import expg_from_probabilities
from data_loader import (
    safe_float as _safe_float, f_feat as _f_feat,
    get_historical_patterns, get_advanced_xg_adjustment,
    get_league_goals_multiplier,
)
from feature_engineer import (
    calculate_xg_perf_delta, calculate_dmf_hafiz, calculate_fatigue_mod,
    calculate_composite_defense, get_stylistic_clash_modifier,
    apply_tactical_intelligence,
)
from data_loader import get_tactical_connection
from goal_model import load_or_fit_goalmodel_parameters


def compute_base_xg(match_obj, features, raw_features, h_hist, a_hist,
                    perf_delta_h, perf_delta_a, home_name, away_name, league_name_str):
    """
    Compute base xG from multiple sources and apply QoP deltas.
    Returns: (xg_h, xg_a, base_xg_h, base_xg_a, analysis)
    """
    analysis = {}

    # Source 1: Pre-computed from match object
    raw_xg_h = float(match_obj.get('home_xg') or 0)
    raw_xg_a = float(match_obj.get('away_xg') or 0)

    # Source 2: Team season averages from teamStats
    team_stats = match_obj.get('teamStats') or {}
    if isinstance(team_stats, str):
        try: team_stats = json.loads(team_stats)
        except Exception: team_stats = {}
    if not isinstance(team_stats, dict): team_stats = {}
    h_stats = team_stats.get('home') or {}
    a_stats = team_stats.get('away') or {}
    avg_xg_h = (float(h_stats.get('avgGoalsScored') or 0) + float(a_stats.get('avgGoalsConceded') or 0)) / 2.0
    avg_xg_a = (float(a_stats.get('avgGoalsScored') or 0) + float(h_stats.get('avgGoalsConceded') or 0)) / 2.0

    # Source 3: Advanced Weighted Historical
    league_name = match_obj.get('league', 'Unknown')
    hist_xg_h, hist_xg_a = get_advanced_xg_adjustment(home_name, away_name, league_name, features)

    # Source 4: Reverse-engineer xG from odds probabilities
    _odds_1x2 = None
    try:
        _odds_1 = float(match_obj.get('odds_home') or 0)
        _odds_d = float(match_obj.get('odds_draw') or 0)
        _odds_2 = float(match_obj.get('odds_away') or 0)
        if min(_odds_1, _odds_d, _odds_2) > 1.01:
            _p1 = 1.0 / _odds_1
            _pd = 1.0 / _odds_d
            _p2 = 1.0 / _odds_2
            _total_p = _p1 + _pd + _p2
            _p1 /= _total_p; _pd /= _total_p; _p2 /= _total_p
            _odds_1x2 = (_p1, _pd, _p2)
    except Exception:
        pass

    # Choose best available source
    if raw_xg_h > 0.1 and raw_xg_a > 0.1:
        xg_h, xg_a = raw_xg_h, raw_xg_a
    elif avg_xg_h > 0.1 and avg_xg_a > 0.1:
        xg_h, xg_a = avg_xg_h, avg_xg_a
    elif _odds_1x2 is not None:
        _expg = expg_from_probabilities(_odds_1x2[0], _odds_1x2[1], _odds_1x2[2])
        if _expg.get('success'):
            xg_h, xg_a = _expg['expg_home'], _expg['expg_away']
            analysis['xG Source'] = 'Odds Reverse-Engineering'
        else:
            xg_h, xg_a = hist_xg_h, hist_xg_a
    else:
        xg_h, xg_a = hist_xg_h, hist_xg_a

    base_xg_h, base_xg_a = xg_h, xg_a

    # Apply xG-Elo Performance Deltas (QoP)
    xg_h *= (1.0 + (perf_delta_h * 0.05))
    xg_a *= (1.0 + (perf_delta_a * 0.05))

    return xg_h, xg_a, base_xg_h, base_xg_a, analysis, h_stats, a_stats


def apply_style_and_time_machine(xg_h, xg_a, h_stats, a_stats, home_name, away_name, match_month):
    """Apply tactical style matching + time machine historical patterns."""
    from ml_features import get_detailed_team_style
    h_style = get_detailed_team_style(h_stats)
    a_style = get_detailed_team_style(a_stats)
    style_h_mod, style_a_mod = get_stylistic_clash_modifier(h_style, a_style)

    xg_h *= style_h_mod
    xg_a *= style_a_mod

    # Time Machine Patterns
    pat_h, pat_a = get_historical_patterns(home_name, away_name, match_month)
    conf_mod = 0.0
    active_patterns = []
    if pat_h:
        xg_h *= float(pat_h.get('xg_modifier', 1.0))
        conf_mod += float(pat_h.get('confidence_modifier', 0))
        active_patterns.append(f"[{home_name}] {pat_h.get('description')}")
    if pat_a:
        xg_a *= float(pat_a.get('xg_modifier', 1.0))
        conf_mod -= float(pat_a.get('confidence_modifier', 0))
        active_patterns.append(f"[{away_name}] {pat_a.get('description')}")

    return xg_h, xg_a, style_h_mod, style_a_mod, h_style, a_style, conf_mod, active_patterns


def apply_squad_intelligence(xg_h, xg_a, match_obj, news_data):
    """
    Apply V50 injury matrix modifiers to h_att_mod/h_def_mod/a_att_mod/a_def_mod.
    Returns: (h_att_mod, h_def_mod, a_att_mod, a_def_mod)
    """
    h_att_mod = 1.0
    h_def_mod = 1.0
    a_att_mod = 1.0
    a_def_mod = 1.0

    intel_h = news_data.get('home', {}).get('intelligence', {}).get('features', {}) if isinstance(news_data, dict) else {}
    intel_a = news_data.get('away', {}).get('intelligence', {}).get('features', {}) if isinstance(news_data, dict) else {}

    h_is_gk_out = float(intel_h.get('is_missing_gk') or match_obj.get('is_missing_gk', 0))
    h_is_scorer_out = float(intel_h.get('is_missing_scorer') or match_obj.get('is_missing_scorer', 0))
    h_is_captain_out = float(intel_h.get('is_missing_captain') or match_obj.get('is_missing_captain', 0))
    h_is_star_out = float(intel_h.get('is_missing_star') or match_obj.get('is_missing_star', 0))

    a_is_gk_out = float(intel_a.get('is_missing_gk') or match_obj.get('is_missing_gk_away', 0))
    a_is_scorer_out = float(intel_a.get('is_missing_scorer') or match_obj.get('is_missing_scorer_away', 0))
    a_is_captain_out = float(intel_a.get('is_missing_captain') or match_obj.get('is_missing_captain_away', 0))
    a_is_star_out = float(intel_a.get('is_missing_star') or match_obj.get('is_missing_star_away', 0))

    if h_is_gk_out > 0: h_def_mod *= 1.25
    if h_is_scorer_out > 0: h_att_mod *= 0.70
    if h_is_star_out > 0 or h_is_captain_out > 0:
        h_att_mod *= 0.85
        h_def_mod *= 1.15

    if a_is_gk_out > 0: a_def_mod *= 1.25
    if a_is_scorer_out > 0: a_att_mod *= 0.70
    if a_is_star_out > 0 or a_is_captain_out > 0:
        a_att_mod *= 0.85
        a_def_mod *= 1.15

    return h_att_mod, h_def_mod, a_att_mod, a_def_mod


def compute_dmf_fatigue(match_obj, features, h_hist, a_hist, h_att_mod, h_def_mod, a_att_mod, a_def_mod):
    """
    Compute DMF (Dynamic Motivation Factor) and fatigue modifiers.
    Returns: (xg_h, xg_a, h_dmf, a_dmf, h_fatigue, a_fatigue, h_is_dz, a_is_dz,
              motivation_signature, h_att_mod, h_def_mod, a_att_mod, a_def_mod)
    """
    h_target_w = float(match_obj.get('home_target_weight', 0))
    a_target_w = float(match_obj.get('away_target_weight', 0))

    h_is_dz = (h_target_w < 0.1) and (len(h_hist) > 5)
    a_is_dz = (a_target_w < 0.1) and (len(a_hist) > 5)

    h_dmf = calculate_dmf_hafiz(h_target_w, _f_feat('home_distance_target', match_obj, 0), _f_feat('home_matches_remaining', match_obj, 10), len(h_hist), is_dead_zone=h_is_dz)
    a_dmf = calculate_dmf_hafiz(a_target_w, _f_feat('away_distance_target', match_obj, 0), _f_feat('away_matches_remaining', match_obj, 10), len(a_hist), is_dead_zone=a_is_dz)

    h_fatigue = calculate_fatigue_mod(_f_feat('rest_h', features, 7))
    a_fatigue = calculate_fatigue_mod(_f_feat('rest_a', features, 7))

    # V54 End of Season Signature
    motivation_signature = "Logique Standard"
    if h_dmf > 1.2 and a_is_dz:
        motivation_signature = "🚨 ENJEU CRITIQUE vs ZONE MORTE (H)"
    elif a_dmf > 1.2 and h_is_dz:
        motivation_signature = "🚨 ENJEU CRITIQUE vs ZONE MORTE (A)"
    elif h_is_dz and a_is_dz:
        motivation_signature = "💤 MATCH DE CLÔTURE (ZONE MORTE)"
    elif h_dmf > 1.15 and a_dmf > 1.15:
        motivation_signature = "⚔️ CHOC DE MOTIVATION"

    is_elite = False  # Passed from caller if needed

    h_att_mod *= h_dmf * h_fatigue
    h_def_mod *= h_dmf * h_fatigue
    a_att_mod *= a_dmf * a_fatigue
    a_def_mod *= a_dmf * a_fatigue

    return h_dmf, a_dmf, h_fatigue, a_fatigue, h_is_dz, a_is_dz, motivation_signature, h_att_mod, h_def_mod, a_att_mod, a_def_mod


def apply_market_and_league(xg_h, xg_a, features, match_obj, h_att_mod, a_att_mod,
                            h_composite_attack, a_composite_attack, league_name_str):
    """Apply V47 market layer + league goals multiplier + composite defense."""
    h_mkt = _f_feat('home_market_value', match_obj, 0)
    a_mkt = _f_feat('away_market_value', match_obj, 0)
    ref_bias = _f_feat('referee_home_win_rate', match_obj, 0.45)

    # Market Value Ratio
    if h_mkt > 0 and a_mkt > 0:
        mvr = h_mkt / a_mkt
        if mvr > 2.5:
            h_att_mod *= 1.10
            a_att_mod *= 0.90
        elif mvr < 0.4:
            a_att_mod *= 1.10
            h_att_mod *= 0.90

    # Referee Home Bias
    if ref_bias > 0.52:
        h_att_mod *= 1.05
    elif ref_bias < 0.38:
        a_att_mod *= 1.05

    # Composite Attack Strength
    h_sot_ratio = features.get('h_sot', 4.0) / max(features.get('a_sot', 4.0), 0.1)
    a_sot_ratio = features.get('a_sot', 4.0) / max(features.get('h_sot', 4.0), 0.1)
    h_bc_ratio = features.get('h_bc', 1.5) / max(features.get('a_bc', 1.5), 0.1)
    a_bc_ratio = features.get('a_bc', 1.5) / max(features.get('h_bc', 1.5), 0.1)
    h_pos_ratio = features.get('h_pos', 50.0) / 100.0
    a_pos_ratio = features.get('a_pos', 50.0) / 100.0

    h_composite_attack = (h_sot_ratio * 0.4) + (h_bc_ratio * 0.4) + (h_pos_ratio * 0.2)
    a_composite_attack = (a_sot_ratio * 0.4) + (a_bc_ratio * 0.4) + (a_pos_ratio * 0.2)

    # League goals multiplier + defense index
    league_goals_mult = get_league_goals_multiplier(league_name_str)
    h_def_index = calculate_composite_defense(features, is_home=True)
    a_def_index = calculate_composite_defense(features, is_home=False)

    xg_h = (xg_h * (0.90 + 0.10 * h_composite_attack) / a_def_index) * league_goals_mult
    xg_a = (xg_a * (0.90 + 0.10 * a_composite_attack) / h_def_index) * league_goals_mult

    return xg_h, xg_a, h_composite_attack, a_composite_attack, h_att_mod, a_att_mod


def apply_environmental_and_tactical(xg_h, xg_a, base_xg_h, base_xg_a,
                                     match_obj, features, h_hist, a_hist,
                                     home_name, away_name, league_name_str,
                                     h_composite_attack, a_composite_attack):
    """Apply weather, rotation, tactical intelligence, H2H, power surge, cascade guard."""
    analysis = {}

    # Weather
    weather_desc = str(match_obj.get('weather_desc', '')).lower()
    weather_impact_xg = 1.0
    if 'rain' in weather_desc or 'snow' in weather_desc:
        weather_impact_xg = 0.88
        analysis["Weather"] = "Conditions météo difficiles (Pluie/Neige) - Attente de score plus bas."

    # Rotation
    rotation_penalty = 0.0
    if h_composite_attack < 0.85 or a_composite_attack < 0.85:
        rotation_penalty = 8.0
        analysis["Rotation"] = "Rotation majeure détectée (Héritage Top Players absents)."

    xg_h *= weather_impact_xg
    xg_a *= weather_impact_xg

    # Tactical Intelligence
    xg_h, xg_a, tactical_alerts = apply_tactical_intelligence(match_obj, features, xg_h, xg_a)
    analysis["Tactical"] = tactical_alerts

    # H2H Bête Noire
    from data_loader import calculate_h2h_dominance
    h2h = calculate_h2h_dominance(h_hist, a_hist, home_name, away_name)
    if isinstance(h2h, dict) and h2h['total'] >= 3:
        if h2h['h'] > 0.7:
            xg_h *= 1.15
            analysis["H2H"] = f"🔥 BÊTE NOIRE: {home_name} domine historiquement {away_name}."
        elif h2h['a'] > 0.7:
            xg_a *= 1.15
            analysis["H2H"] = f"🔥 BÊTE NOIRE: {away_name} domine historiquement {home_name}."

    # Power Surge
    h_accel = features.get('explosive_momentum_h', 0.0)
    a_accel = features.get('explosive_momentum_a', 0.0)
    if h_accel > 0.5 and xg_h > 1.8:
        xg_h *= (1.0 + h_accel * 0.1)
        analysis["Power-Surge"] = f"⚡ POWER SURGE (H): {home_name} est en phase d'accélération offensive."
    if a_accel > 0.5 and xg_a > 1.8:
        xg_a *= (1.0 + a_accel * 0.1)
        analysis["Power-Surge"] = f"⚡ POWER SURGE (A): {away_name} est en phase d'accélération offensive."

    # Cascade Guard
    MAX_XG_MOD = 4.0
    MIN_XG_MOD = 0.25
    eff_mod_h = xg_h / max(base_xg_h, 0.01)
    eff_mod_a = xg_a / max(base_xg_a, 0.01)
    if eff_mod_h > MAX_XG_MOD: xg_h = base_xg_h * MAX_XG_MOD
    elif eff_mod_h < MIN_XG_MOD: xg_h = base_xg_h * MIN_XG_MOD
    if eff_mod_a > MAX_XG_MOD: xg_a = base_xg_a * MAX_XG_MOD
    elif eff_mod_a < MIN_XG_MOD: xg_a = base_xg_a * MIN_XG_MOD

    xg_h = max(0.2, min(4.0, xg_h))
    xg_a = max(0.2, min(4.0, xg_a))

    return xg_h, xg_a, analysis, tactical_alerts, rotation_penalty, weather_impact_xg


def apply_dixon_coles_gamma(xg_h, xg_a, league_name_str):
    """Apply Dixon-Coles Rue-Salvesen gamma correction to xG."""
    _gm_params = load_or_fit_goalmodel_parameters(
        league_name_str,
        db_conn=get_tactical_connection()
    )
    _gm_rho = _gm_params.get('rho', -0.12)
    _gm_gamma = _gm_params.get('gamma', 0.0)
    _gm_dist = _gm_params.get('distribution_type', 'poisson')

    if abs(_gm_gamma) > 0.001:
        _strength_ratio = (xg_h - xg_a) / max(xg_h + xg_a, 0.01)
        xg_h *= math.exp(-_gm_gamma * _strength_ratio)
        xg_a *= math.exp(_gm_gamma * _strength_ratio)

    return xg_h, xg_a, _gm_rho, _gm_gamma, _gm_dist
