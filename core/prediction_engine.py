"""
prediction_engine.py — Orchestrator for Titanium AI Prediction Pipeline
Refactored: 1809 → ~300 lines (orchestrator only)

Modules:
  - xg_engine.py: Multi-source xG computation & modifier pipeline
  - ml_ensemble.py: XGBoost model chain, ensemble blending & SHAP
  - market_engine.py: Surgical market selection, precision bets & pro insights
  - confidence_engine.py: Confidence calibration, risk assessment & verdict
  - data_loader.py: DB connections, ELO, team strength, league lookups
  - feature_engineer.py: V4 features, imputation, confidence, DMF
  - model_manager.py: 11 XGBoost loaders, simulate_match_mc()
  - predictor.py: Poisson MC, exact score, live adjustment, DNB/DC
  - post_processor.py: Strategic brief, risk detection, confidence calibration
"""
import json
import sys
import math
import os
import numpy as np

from goal_model import load_or_fit_goalmodel_parameters, expg_from_probabilities

# Fix relative import paths
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import warnings
warnings.filterwarnings("ignore")

__prob_trace__ = []
import logging
logging.getLogger('absl').setLevel(logging.ERROR)

from ml_features import extract_ml_features, FEATURE_NAMES, calculate_rolling_averages, get_team_history, calculate_glicko_momentum
from top_analyst_engine import process_match_for_top_analyst
from leagues_master import classify_league

# --- Module imports (refactored) ---
from data_loader import (
    safe_float as _safe_float, f_feat as _f_feat,
    get_tactical_connection, get_elo_data,
    get_league_goals_multiplier, get_league_draw_multiplier,
    find_twin_matches, apply_gap_learning_weight,
)
from feature_engineer import (
    impute_missing_match_data, calculate_xg_perf_delta,
    calculate_composite_confidence,
)
from model_manager import (
    get_main_booster, get_corners_model, get_cards_model,
)
from predictor import (
    monte_carlo_simulation, calculate_exact_score,
    apply_live_event_adjustment, calculate_ah_dnb_probs,
)
from post_processor import generate_strategic_brief, get_tube_pct

# --- New module imports ---
from xg_engine import (
    compute_base_xg, apply_style_and_time_machine,
    apply_squad_intelligence, compute_dmf_fatigue,
    apply_market_and_league, apply_environmental_and_tactical,
    apply_dixon_coles_gamma,
)
from ml_ensemble import (
    select_model_booster, run_xgboost_inference,
    apply_v4_ensemble, apply_predixsport_blend,
    run_shap_explainability, predict_secondary_markets,
    blend_final_probabilities, LEAGUE_WEIGHT_MATRIX,
)
from market_engine import (
    generate_precision_bets, generate_dnb_ah_bets,
    get_best_surgical_market, generate_pro_insights,
    calculate_poisson_scores, ensure_expected_score_in_cs,
    build_main_four,
)
from confidence_engine import (
    evaluate_confluence, calibrate_confidence,
    apply_draw_and_world_cup, determine_verdict,
    assess_risk, apply_veto_shield,
    build_analysis_report, apply_post_verdict,
)

ELO_DATA = get_elo_data()


def process_prediction(match_obj: dict) -> dict:
    home_name = match_obj.get('homeTeam', 'Home')
    away_name = match_obj.get('awayTeam', 'Away')

    # --- FAIL-FAST & PRE-MATCH BLACKLIST ---
    XGB_BOOSTER = get_main_booster()
    if XGB_BOOSTER is None:
        sys.stderr.write("🛑 FAIL-FAST: XGBoost Model not loaded. Silent fallback to Poisson blocked.\n")
        return {"success": False, "error": "Prediction stopped: XGBoost Model not loaded (Fail-Fast)."}

    league_name_str = str(match_obj.get('league', '')).lower()
    tourn_name_str = str(match_obj.get('tournament_name', '')).lower()
    league_tier, confidence_tag = classify_league(league_name_str, tourn_name_str)

    if league_tier == 'BLACKLIST' and not match_obj.get('force_predict'):
        sys.stderr.write(f"🛑 PRE-MATCH FILTER: Tournament '{league_name_str} {tourn_name_str}' is blacklisted.\n")
        return {"success": False, "error": "Filtered by Pre-Match Policy", "is_suspicious": True}

    sys.stderr.write(f"  [LeagueTier] {league_name_str} -> {league_tier}/{confidence_tag}\n")

    # --- SEEDING: History + Features ---
    h_hist = get_team_history(home_name, limit=30)
    a_hist = get_team_history(away_name, limit=30)
    features = {'h_hist_len': len(h_hist), 'a_hist_len': len(a_hist)}
    features.update(extract_ml_features(match_obj, fetch_history=True))
    raw_features = dict(features)

    # --- V50+ Imputation & QoP ---
    features = impute_missing_match_data(features, match_obj)

    # INSUFFICIENT DATA FILTER — universal guard, stricter for unknown leagues
    data_completeness = features.get('data_completeness', 100)
    dc_threshold = 30.0 if league_tier == 'UNKNOWN' else 15.0
    if data_completeness < dc_threshold:
        sys.stderr.write(f"🛑 PRE-MATCH FILTER: Insufficient data ({data_completeness:.0f}% < {dc_threshold}%) for league '{league_name_str}'. Blocked.\n")
        return {"success": False, "error": "INSUFFICIENT_DATA", "data_completeness": data_completeness}

    perf_delta_h = calculate_xg_perf_delta(h_hist, is_home=True)
    perf_delta_a = calculate_xg_perf_delta(a_hist, is_home=False)
    features['xg_elo_delta_h'] = perf_delta_h
    features['xg_elo_delta_a'] = perf_delta_a
    raw_h_elo = raw_features.get('home_elo', 1500)
    raw_a_elo = raw_features.get('away_elo', 1500)
    features['home_elo'] = raw_h_elo + (perf_delta_h * 15.0)
    features['away_elo'] = raw_a_elo + (perf_delta_a * 15.0)
    features['elo_diff'] = features['home_elo'] - features['away_elo']

    # Time Machine Month
    try:
        ts = int(match_obj.get('startTimestamp', 0))
        import datetime
        match_month = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).month if ts > 0 else datetime.datetime.now().month
    except Exception:
        match_month = datetime.datetime.now().month

    # === PHASE 1: xG COMPUTATION ===
    xg_h, xg_a, base_xg_h, base_xg_a, xg_analysis, h_stats, a_stats = compute_base_xg(
        match_obj, features, raw_features, h_hist, a_hist, perf_delta_h, perf_delta_a,
        home_name, away_name, league_name_str
    )

    xg_h, xg_a, style_h_mod, style_a_mod, h_style, a_style, conf_mod, active_patterns = apply_style_and_time_machine(
        xg_h, xg_a, h_stats, a_stats, home_name, away_name, match_month
    )

    news_data = match_obj.get('news_data')
    if isinstance(news_data, str):
        try: news_data = json.loads(news_data)
        except Exception: news_data = {}
    h_att_mod, h_def_mod, a_att_mod, a_def_mod = apply_squad_intelligence(xg_h, xg_a, match_obj, news_data)

    h_dmf, a_dmf, h_fatigue, a_fatigue, h_is_dz, a_is_dz, motivation_signature, h_att_mod, h_def_mod, a_att_mod, a_def_mod = compute_dmf_fatigue(
        match_obj, features, h_hist, a_hist, h_att_mod, h_def_mod, a_att_mod, a_def_mod
    )

    xg_h, xg_a, h_composite_attack, a_composite_attack, h_att_mod, a_att_mod = apply_market_and_league(
        xg_h, xg_a, features, match_obj, h_att_mod, a_att_mod, 0, 0, league_name_str
    )

    xg_h, xg_a, env_analysis, tactical_alerts, rotation_penalty, weather_wind = apply_environmental_and_tactical(
        xg_h, xg_a, base_xg_h, base_xg_a, match_obj, features, h_hist, a_hist,
        home_name, away_name, league_name_str, h_composite_attack, a_composite_attack
    )

    xg_h, xg_a, gm_rho, gm_gamma, gm_dist = apply_dixon_coles_gamma(xg_h, xg_a, league_name_str)

    # === PHASE 2: ML ENSEMBLE ===
    active_feature_names, active_feature_vector, ai_source, XGB_BOOSTER = select_model_booster(features, league_tier)

    sim = monte_carlo_simulation(xg_h, xg_a, distribution=gm_dist, rho=gm_rho)

    ml_result = run_xgboost_inference(active_feature_vector, active_feature_names, XGB_BOOSTER, sim, features, match_obj, league_name_str, league_tier)
    p_h_xgb, p_d_xgb, p_a_xgb = ml_result['p_h_xgb'], ml_result['p_d_xgb'], ml_result['p_a_xgb']
    p_h_ai, p_d_ai, p_a_ai = ml_result['p_h_ai'], ml_result['p_d_ai'], ml_result['p_a_ai']
    has_xgb = ml_result['has_xgb']
    ai_source = ml_result['ai_source']
    explainer_data = ml_result['explainer_data']
    analysis = ml_result['analysis']

    # V4 Ensemble
    p_h_ai, p_d_ai, p_a_ai, v4_tag, v4_analysis = apply_v4_ensemble(p_h_ai, p_d_ai, p_a_ai, match_obj, has_xgb)
    analysis.update(v4_analysis)
    ai_source += v4_tag

    # PredixSport Blend
    p_h_ai, p_d_ai, p_a_ai, ps_tag, ps_analysis = apply_predixsport_blend(p_h_ai, p_d_ai, p_a_ai, match_obj)
    analysis.update(ps_analysis)
    ai_source += ps_tag

    # SHAP Explainability
    if has_xgb:
        try:
            explainer_data = run_shap_explainability(active_feature_vector, active_feature_names, XGB_BOOSTER, p_h_xgb, p_d_xgb, p_a_xgb)
        except Exception as e:
            sys.stderr.write(f"⚠️ [SHAP] {e}\n")

    # Secondary Markets
    feature_vector = [_f_feat(f, features, 0) for f in FEATURE_NAMES]
    expected_corners, expected_cards = predict_secondary_markets(features, feature_vector)

    # === PHASE 3: GLOBAL BLENDING ===
    p_h_poi, p_d_poi, p_a_poi = sim['p_h'], sim['p_d'], sim['p_a']

    # Glicko Momentum
    h_mom = calculate_glicko_momentum(h_hist, window=5)
    a_mom = calculate_glicko_momentum(a_hist, window=5)
    if h_mom > a_mom * 1.5: p_h_poi *= 1.05
    elif a_mom > h_mom * 1.5: p_a_poi *= 1.05

    # Odds Steam
    odds_drop_h = _f_feat('odds_drop_home', match_obj, 0)
    odds_drop_a = _f_feat('odds_drop_away', match_obj, 0)
    if odds_drop_h > 5.0: p_h_poi *= (1.0 + (odds_drop_h / 100.0))
    if odds_drop_a > 5.0: p_a_poi *= (1.0 + (odds_drop_a / 100.0))

    # Top Analyst Pre-Inference
    _ta_result = {}
    try:
        _ta_result = process_match_for_top_analyst(match_obj)
        features.update(_ta_result.get('ml_features', {}))
    except Exception as _ta_err:
        sys.stderr.write(f"⚠️ [TA-Pre] {_ta_err}\n")

    p_h, p_d, p_a, ai_fusion_weight, ai_source_label = blend_final_probabilities(
        p_h_ai, p_d_ai, p_a_ai, p_h_poi, p_d_poi, p_a_poi, has_xgb
    )
    if ai_source == "Standard-Poisson":
        ai_source = ai_source_label

    # Confluence Guard
    confluence_penalty, confluence_report, confluence_reason = evaluate_confluence(
        p_h_xgb, p_d_xgb, p_a_xgb, p_h_poi, p_d_poi, p_a_poi,
        h_mom, a_mom, league_tier, has_xgb, match_obj
    )
    analysis["Confluence"] = confluence_reason

    # Gap Learning
    final_probs, gap_correction = apply_gap_learning_weight({"home": p_h, "draw": p_d, "away": p_a}, match_obj.get('league', 'Unknown'))
    p_h, p_d, p_a = final_probs['home'], final_probs['draw'], final_probs['away']

    # Composite Confidence
    lineups_active = bool(match_obj.get('lineups_confirmed') or match_obj.get('lineups'))
    data_comp = features.get('data_completeness', 100.0)
    composite_confidence = calculate_composite_confidence(max(p_h, p_d, p_a), h_dmf, a_dmf, lineups_active, data_comp)

    # PWR Shot Efficiency
    h_shot_eff = _safe_float(features.get('h_sot', 4.0)) / max(_safe_float(features.get('h_pos', 50.0)) / 10.0, 0.1)
    a_shot_eff = _safe_float(features.get('a_sot', 4.0)) / max(_safe_float(features.get('a_pos', 50.0)) / 10.0, 0.1)
    pwr_score_est = max(50, (_safe_float(xg_h) * 15 * 0.90) + (_safe_float(h_composite_attack) * 15 * 0.10) + 50)

    if pwr_score_est > 95:
        eff_advantage = h_shot_eff / max(a_shot_eff, 0.01)
        if eff_advantage > 1.15:
            p_h = min(0.93, p_h * (1.0 + (eff_advantage - 1.0) * 0.35))
            p_d *= 0.10
            p_sum_pwr = p_h + p_d + p_a
            p_h, p_d, p_a = p_h/p_sum_pwr, p_d/p_sum_pwr, p_a/p_sum_pwr

    # Live Adjustment
    p_h, p_d, p_a, live_alerts = apply_live_event_adjustment(match_obj, p_h, p_d, p_a)
    p_sum_final = p_h + p_d + p_a
    if p_sum_final > 0:
        p_h, p_d, p_a = p_h/p_sum_final, p_d/p_sum_final, p_a/p_sum_final

    p_home, p_draw, p_away = p_h*100, p_d*100, p_a*100

    # Deep Audit
    deep_audit_required = False
    if has_xgb:
        gap = abs(p_h - p_h_xgb) + abs(p_d - p_d_xgb) + abs(p_a - p_a_xgb)
        if gap > 0.45: deep_audit_required = True

    expected_score = calculate_exact_score(xg_h, xg_a, p_home, p_away, distribution=gm_dist, rho=gm_rho, gamma=gm_gamma)
    gh, ga = 0, 0
    if " - " in expected_score:
        try: gh, ga = map(int, expected_score.split(" - "))
        except Exception: pass

    # Selection Init
    selection_prob = 0.34
    selection_label = "Nul"
    selection = "Draw"

    # Precision Bets
    mc_ou25 = _f_feat('ou_25_prob', sim, 0.5) * 100
    mc_ou35 = _f_feat('ou_35_prob', sim, 0.3) * 100
    mc_ou15 = _f_feat('ou_15_prob', sim, 0.7) * 100

    h_dominance = (h_shot_eff * 1.2) + (h_composite_attack * 0.8)
    a_dominance = (a_shot_eff * 1.2) + (a_composite_attack * 0.8)

    precision_bets = generate_precision_bets(
        xg_h, xg_a, p_h, p_d, p_a, mc_ou25, mc_ou35, mc_ou15,
        expected_corners, expected_cards, home_name, away_name,
        has_xgb, features
    )
    dnb_h, dnb_a, dc_h, dc_a, dc_12 = calculate_ah_dnb_probs(p_h, p_d, p_a)
    dnb_ah_bets, dnb_h, dnb_a, dc_h, dc_a, dc_12 = generate_dnb_ah_bets(
        p_h, p_d, p_a, selection, home_name, away_name, h_dominance, a_dominance
    )
    precision_bets.extend(dnb_ah_bets)

    # === PHASE 4: SURGICAL MARKET + CONFIDENCE ===
    surgical_verdict, backup_verdict = get_best_surgical_market(
        match_obj, selection, selection_label, selection_prob,
        p_h, p_d, p_a, xg_h, xg_a, mc_ou25,
        league_tier, home_name, away_name,
        _f_feat('home_big_chances', features, 1.0), _f_feat('away_big_chances', features, 1.0),
        dnb_h, dnb_a, h_composite_attack, a_composite_attack
    )
    selection_label = surgical_verdict['type']
    surgical_confidence = float(surgical_verdict['confidence'])
    confidence = surgical_confidence
    pattern_desc = surgical_verdict['desc']
    backup_label = backup_verdict['type'] if backup_verdict else "N/A"
    backup_conf = backup_verdict['confidence'] if backup_verdict else 0

    # Confidence Calibration
    confidence, reliability_index, is_value_bet, value_index, cal_analysis = calibrate_confidence(
        p_h, p_d, p_a, selection_prob, composite_confidence, surgical_confidence,
        confluence_penalty, h_dmf, a_dmf, features, match_obj,
        style_h_mod, style_a_mod, league_tier, league_name_str, confidence_tag, conf_mod
    )
    analysis.update(cal_analysis)

    # Draw & World Cup
    p_h, p_d, p_a, wc_conf_adj = apply_draw_and_world_cup(p_h, p_d, p_a, league_name_str, tourn_name_str, features, analysis)
    confidence += wc_conf_adj

    # Final Selection
    outcomes = [
        ("Home", p_h, _safe_float(match_obj.get('odds_home') or match_obj.get('home_odds'), 0.0), _safe_float(match_obj.get('odds_home_open'), 0.0)),
        ("Draw", p_d, _safe_float(match_obj.get('odds_draw') or match_obj.get('draw_odds'), 0.0), _safe_float(match_obj.get('odds_draw_open'), 0.0)),
        ("Away", p_a, _safe_float(match_obj.get('odds_away') or match_obj.get('away_odds'), 0.0), _safe_float(match_obj.get('odds_away_open'), 0.0))
    ]
    best_outcome = max(outcomes, key=lambda x: x[1])
    selection = best_outcome[0]
    win_prob = best_outcome[1] * 100
    odds = best_outcome[2]
    odds_open = best_outcome[3]

    # Rolling Averages
    h_roll_g3, h_roll_p3 = calculate_rolling_averages(h_hist, window=3)
    a_roll_g3, a_roll_p3 = calculate_rolling_averages(a_hist, window=3)
    ref_name = match_obj.get('referee') or match_obj.get('refereeName')

    total_absentee_impact = 0
    if h_att_mod < 0.95 or a_att_mod < 0.95 or h_def_mod > 1.05 or a_def_mod > 1.05:
        total_absentee_impact = abs(1.0 - h_att_mod) + abs(1.0 - a_att_mod)

    is_smart_money = False
    odds_drop_pct = 0
    is_confirmed = confidence >= 85

    # Poisson CS
    cs_predictions = calculate_poisson_scores(xg_h, xg_a, selection)
    cs_predictions = ensure_expected_score_in_cs(cs_predictions, expected_score, xg_h, xg_a)

    # Analysis Report
    report_analysis = build_analysis_report(
        features, home_name, away_name, selection, selection_label,
        h_mom, a_mom, h_roll_p3, a_roll_p3, perf_delta_h, perf_delta_a,
        xg_h, xg_a, style_h_mod, style_a_mod, h_style, a_style,
        h_dmf, a_dmf, motivation_signature, h_is_dz, a_is_dz,
        total_absentee_impact, is_smart_money, odds_drop_pct,
        value_index, confidence, ref_name, selection_prob, features
    )
    analysis.update(report_analysis)

    # Verdict
    verdict = apply_post_verdict(confidence, surgical_confidence, value_index, league_tier, analysis)

    # Power Tubes
    def _get_tube_pct(val_0_100):
        pct = int(min(100, max(0, val_0_100)))
        return f"{pct}%"

    power_tubes = {
        "Attack Strength": _get_tube_pct(features.get('home_possession', 50) + (xg_h * 15)),
        "Defense Strength": _get_tube_pct(100 - (xg_a * 20)),
        "Recent Form": _get_tube_pct(((h_mom * 10) + (h_roll_p3 * 20)) / 2),
        "Team Momentum": _get_tube_pct(h_mom * 25 if h_mom > 0 else 40),
        "Motivation Level": _get_tube_pct(h_dmf * 50)
    }

    # Main Four
    main_four = build_main_four(selection_label, mc_ou25, xg_h, xg_a, surgical_verdict,
                                _ta_result.get("direct_prediction", ""), home_name, away_name, selection, gh, ga)
    direct_prediction = _ta_result.get("direct_prediction", verdict)
    ta_features = _ta_result.get("ml_features", {})

    # Strategic Brief
    strategic_brief = generate_strategic_brief(features, home_name, away_name, selection, match_obj=match_obj)

    # Pro Insights
    tactical_alerts = env_analysis.get("Tactical", []) if isinstance(env_analysis.get("Tactical"), list) else []
    pro_insights = generate_pro_insights(
        selection, confidence, league_tier, league_name_str,
        is_value_bet, value_index, h_dmf, a_dmf,
        home_name, away_name, tactical_alerts, analysis, mc_ou25
    )

    # Risk Assessment
    odds_h = _safe_float(match_obj.get('odds_home') or match_obj.get('home_odds'), 0.0)
    odds_d = _safe_float(match_obj.get('odds_draw') or match_obj.get('draw_odds'), 0.0)
    odds_a = _safe_float(match_obj.get('odds_away') or match_obj.get('away_odds'), 0.0)
    odds_h_open = _safe_float(match_obj.get('odds_home_open'), odds_h)
    odds_a_open = _safe_float(match_obj.get('odds_away_open'), odds_a)

    risk_score, risk_reasons, is_suspicious_flag, is_safe_bet_flag = assess_risk(
        league_tier, h_dmf, a_dmf, h_is_dz, a_is_dz,
        odds_h, odds_d, odds_a, odds_h_open, odds_a_open,
        p_h, p_a, features, confidence
    )

    # Veto Shield
    data_completeness_score = features.get('data_completeness', 50.0)
    no_bet, veto_verdict, zero_failure_veto, shield_reason = apply_veto_shield(
        risk_score, confidence, reliability_index, data_completeness_score,
        league_tier, match_obj
    )
    if zero_failure_veto:
        analysis["Shield"] = shield_reason
    if veto_verdict:
        verdict = veto_verdict

    # Friendly/Tier1 thresholds
    tournament_tag = str(match_obj.get('league', '')).lower()
    is_friendly_match = any(x in tournament_tag for x in ['friendly', 'amical', 'friendlies'])
    comp_threshold = 5.0 if is_friendly_match else 20.0
    is_tier1 = any(x in tournament_tag for x in ['africa cup', 'afcon', 'champions league', 'nations cup', 'premier league', 'ligue 1', 'laliga', 'serie a', 'bundesliga'])

    # V75.2 Alpha Mode
    is_elite_tier = (league_tier == 'T1')
    effective_confidence = max(confidence, surgical_confidence)
    if effective_confidence < 50.0 and is_elite_tier:
        analysis["Shield"] = f"🛡️ VETO ALPHA: Confiance < 50%."

    if no_bet:
        verdict = "NO BET (SHIELDED)" if zero_failure_veto else "NO BET"
        selection = "No Bet"
        selection_label = "No Bet"
        confidence = 0
        precision_bets = []

    if data_completeness_score < comp_threshold:
        no_bet = True
        verdict = "NO BET"
        selection = "No Bet"
        selection_label = "No Bet"

    power_score = round(max(50, (_safe_float(xg_h, 1.2) * 15 * 0.90) + (_safe_float(h_composite_attack, 0.5) * 15 * 0.10) + 50), 1)

    # Dynamic Threshold
    dynamic_threshold = 15.0
    if confidence < dynamic_threshold:
        sys.stderr.write(f"🛑 REJECTED [{league_tier}]: Extreme Low Confidence ({confidence:.1f}% < {dynamic_threshold:.1f}%).\n")
        return {"success": False, "error": f"Prediction stopped: Confidence too low ({confidence:.1f}%)."}

    # Twin Match DNA
    twin_dna = find_twin_matches(odds_h, odds_d, odds_a, xg_h - xg_a)
    twin_verdict = "N/A"
    if twin_dna and twin_dna['total'] >= 5:
        h_pct = (twin_dna['home'] / twin_dna['total']) * 100
        d_pct = (twin_dna['draw'] / twin_dna['total']) * 100
        a_pct = (twin_dna['away'] / twin_dna['total']) * 100
        if h_pct > 50: twin_verdict = f"Historical DNA favors Home ({h_pct:.0f}%)"
        elif a_pct > 50: twin_verdict = f"Historical DNA favors Away ({a_pct:.0f}%)"
        elif d_pct > 35: twin_verdict = f"Historical DNA favors Draw ({d_pct:.0f}%)"
        else: twin_verdict = "Historical DNA is balanced"

    # Debug Trace
    __prob_trace__.append({
        "selection_label": selection_label if not no_bet else "NO BET",
        "verdict": verdict,
        "p_h": float(p_h), "p_d": float(p_d), "p_a": float(p_a),
        "confidence": float(confidence),
        "p_h_xgb": float(p_h_xgb), "p_d_xgb": float(p_d_xgb), "p_a_xgb": float(p_a_xgb),
        "changed": not (abs(p_h_xgb - p_h) < 1e-9 and abs(p_d_xgb - p_d) < 1e-9 and abs(p_a_xgb - p_a) < 1e-9)
    })
    try:
        _tf = os.path.join(os.environ.get('TEMP', '/tmp'), 'opencode', 'prob_trace.jsonl')
        _d = os.path.dirname(_tf)
        if not os.path.exists(_d):
            os.makedirs(_d, exist_ok=True)
        with open(_tf, 'a', encoding='utf-8') as _f:
            _f.write(json.dumps(__prob_trace__[-1], default=str) + '\n')
    except Exception:
        pass

    # Kelly Stake
    temp_odds = odds if odds > 1 else (odds_a if selection == "Away" else odds_d)
    temp_win_prob = (surgical_confidence / 100.0) if surgical_confidence > 1 else (surgical_confidence / 100.0)

    # === FINAL SERIALIZATION ===
    return {
        "success": True,
        "is_suspicious": is_suspicious_flag,
        "is_safe_bet": is_safe_bet_flag,
        "risk_score": float(risk_score),
        "risk_reasons": risk_reasons,
        "league_tier": str(league_tier),
        "ai_source": str(ai_source),
        "xgboost_confidence": float(confidence / 100.0),
        "home_win_probability": float(p_h),
        "draw_probability": float(p_d),
        "away_win_probability": float(p_a),
        "xgboost_probs_h": float(p_h_xgb),
        "xgboost_probs_d": float(p_d_xgb),
        "xgboost_probs_a": float(p_a_xgb),
        "ou_25_prob": float(sim['ou_25_prob']),
        "btts_prob": float(sim['btts_prob']),
        "verdict": str("NO BET" if no_bet else selection_label),
        "power_score": float(power_score),
        "chaos_level": float(0.0),
        "main_predictions": main_four,
        "power_tubes": power_tubes,
        "detailed_analysis": analysis,
        "expected_score": str(expected_score),
        "is_confirmed": bool(is_confirmed),
        "expected_corners": float(expected_corners),
        "expected_cards": float(expected_cards),
        "precision_bets": precision_bets,
        "deep_audit_required": bool(deep_audit_required),
        "explainer_data": explainer_data,
        "top_analyst_features": ta_features,
        "direct_prediction": str(direct_prediction),
        "reliability_index": float(round(reliability_index, 1)),
        "strategic_brief": str(strategic_brief),
        "dnb_probs": {"home": float(round(dnb_h*100, 1)), "away": float(round(dnb_a*100, 1))},
        "dc_probs": {"1X": float(round(dc_h*100, 1)), "X2": float(round(dc_a*100, 1)), "12": float(round(dc_12*100, 1))},
        "v22_success_rate": float(round(min(85.0, (power_score * 0.4) + (confidence * 0.6) - rotation_penalty + (10 if is_smart_money else 0)), 1)),
        "total_goals_label": str(f"+2.5 Buts" if mc_ou25 >= 55 else f"-2.5 Buts"),
        "chaos_factor_msg": str("Force du vent: Chaos (+)" if weather_wind > 25 else ("💰 Smart Money Tracked" if is_smart_money else "Logique Stable")),
        "smart_money_active": bool(is_smart_money),
        "pro_insights": pro_insights,
        "surgical_market": str(selection_label),
        "surgical_confidence": float(confidence),
        "pattern_analysis": str(pattern_desc),
        "backup_market": str(backup_label),
        "backup_confidence": float(backup_conf),
        "motivation_signature": str(motivation_signature),
        "twin_match_dna": twin_dna,
        "twin_match_verdict": twin_verdict,
        "kelly_stake": float(round(max(0, (((confidence/100) * (temp_odds-1)) - (1-(confidence/100))) / (temp_odds-1) * 0.25 * 100), 1)) if (temp_odds > 1 and confidence > 0) else 0
    }


if __name__ == "__main__":
    import sys
    try:
        input_data = sys.stdin.read()
        if input_data.strip():
            result = process_prediction(json.loads(input_data))
            print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
