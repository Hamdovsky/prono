"""
confidence_engine.py — Confidence Calibration, Risk Assessment & Verdict
Extracted from prediction_engine.py (Lines 830-897, 1197-1353, 1434-1506, 1508-1529, 1619-1688)

Responsibilities:
  1. Confluence Guard triple validation (XGBoost + Poisson + Market)
  2. Gap Learning weight adjustment
  3. Composite confidence calculation with multiple calibration stages
  4. Verdict determination (SAFE BET / RISKY / NO BET / SURGICAL STRIKE)
  5. Risk score assessment (7 rules)
  6. Veto shield logic
  7. World Cup / FIFA rank logic
  8. 10-point analysis report
"""
import json
import sys
from pathlib import Path
from data_loader import (
    safe_float as _safe_float, f_feat as _f_feat,
    apply_gap_learning_weight, get_league_draw_multiplier,
    get_league_volatility_penalty, get_h2h_modifier,
)
from feature_engineer import calculate_composite_confidence
try:
    from calibration_iso import isotonic_calibrate
except Exception:
    isotonic_calibrate = None

# Veto Guard / Safety Bracket
_OVERCONF_MIN_PROB = 0.70      # prob pick >= 70 %
_OVERCONF_MAX_HIT = 0.55       # hit-rate historique du bracket < 55% (stricter)
_OVERCONF_MIN_SAMPLES = 20     # samples minimum pour faire confiance au bracket (was 5)
_OVERCONF_DATA_DIRS = (
    Path(__file__).resolve().parents[1] / "data",     # stitch/data
    Path(__file__).resolve().parents[2] / "data",     # repo racine/data
)


def _bracket_key(prob: float) -> str:
    """Bande de calibration (10 %) pour une probabilité pick 0-1."""
    if prob >= 0.90:
        return "90-100"
    if prob >= 0.80:
        return "80-90"
    if prob >= 0.70:
        return "70-80"
    if prob >= 0.60:
        return "60-70"
    if prob >= 0.50:
        return "50-60"
    if prob >= 0.40:
        return "40-50"
    if prob >= 0.30:
        return "30-40"
    if prob >= 0.20:
        return "20-30"
    if prob >= 0.10:
        return "10-20"
    return "0-10"


def load_bracket_accuracy() -> dict:
    """Charge le taux de succès historique par bande de confiance.

    Sources (fusion, priorité à la plus fraîche) :
      - data/backtest_results.json  → bracketAccuracy (bandes 0-50…90+)
      - data/accuracy_report.json   → cumulative.calibrationCurve (bandes 10 %)
    Retourne {band: {"accuracy": float (0-1), "count": int}}.
    """
    brackets: dict[str, dict] = {}
    for d in _OVERCONF_DATA_DIRS:
        for fname in ("backtest_results.json", "accuracy_report.json"):
            p = d / fname
            if not p.exists():
                continue
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            if fname == "backtest_results.json":
                for band, info in (data.get("bracketAccuracy") or {}).items():
                    if not isinstance(info, dict):
                        continue
                    hit = _safe_float(info.get("accuracy"), None)
                    if hit is None:
                        continue
                    # Normalise "90+" (backtest) vers "90-100" (calibrationCurve)
                    if band == "90+":
                        band = "90-100"
                    brackets.setdefault(band, {"accuracy": 0.0, "count": 0})
                    old_acc = brackets[band]["accuracy"]
                    old_n = brackets[band]["count"]
                    n = int(info.get("count", 0) or 0)
                    if old_n + n > 0:
                        brackets[band]["accuracy"] = (old_acc * old_n + (hit / 100.0) * n) / (old_n + n)
                    brackets[band]["count"] = old_n + n
            else:
                curve = (data.get("cumulative") or {}).get("calibrationCurve") or []
                for entry in curve:
                    band = entry.get("band")
                    acc = entry.get("accuracy")
                    n = int(entry.get("count", 0) or 0)
                    if not band or acc is None or n <= 0:
                        continue
                    brackets.setdefault(band, {"accuracy": 0.0, "count": 0})
                    old_acc = brackets[band]["accuracy"]
                    old_n = brackets[band]["count"]
                    brackets[band]["accuracy"] = (old_acc * old_n + (acc / 100.0) * n) / (old_n + n)
                    brackets[band]["count"] = old_n + n
    return brackets


def overconfidence_veto(pick_probability, bracket_accuracy=None,
                        min_prob=_OVERCONF_MIN_PROB, max_hit=_OVERCONF_MAX_HIT,
                        min_samples=_OVERCONF_MIN_SAMPLES):
    """Safety Bracket : prob pick >= 0.70 mais taux de succès historique du
    bracket < 0.60 → veto de la recommandation.

    Retourne (veto: bool, reason: str). bracket_accuracy peut être injecté
    (tests) ; sinon chargé depuis les rapports data/.
    """
    try:
        if pick_probability is None or pick_probability < min_prob:
            return False, ""
        if bracket_accuracy is None:
            bracket_accuracy = load_bracket_accuracy()
        band = _bracket_key(pick_probability)
        info = bracket_accuracy.get(band)
        if not info or int(info.get("count", 0)) < min_samples:
            return False, ""
        hit = _safe_float(info.get("accuracy"), None)
        if hit is None or hit >= max_hit:
            return False, ""
        reason = (f"Veto Guard: prob pick {pick_probability:.0%} mais historique "
                  f"bracket {band} = {hit:.0%} (n={info['count']}) < {max_hit:.0%} → NO BET")
        return True, reason
    except Exception as e:
        sys.stderr.write(f"⚠️ [VetoGuard] {e}\n")
        return False, ""


def _get_external_probs(match_obj):
    """Returns external msoczi XGBoost probs (h, d, a) from match_obj if present."""
    try:
        _ext = match_obj.get('_external_xgb')
        if _ext and isinstance(_ext, dict):
            _h = _safe_float(_ext.get('home'), -1.0)
            _d = _safe_float(_ext.get('draw'), -1.0)
            _a = _safe_float(_ext.get('away'), -1.0)
            if _h >= 0 and _d >= 0 and _a >= 0 and (_h + _d + _a) > 0:
                return (_h, _d, _a)
    except Exception:
        pass
    return None


def evaluate_confluence(p_h_xgb, p_d_xgb, p_a_xgb, p_h_poi, p_d_poi, p_a_poi,
                        h_mom, a_mom, league_tier, has_xgb, match_obj):
    """
    V110 Triple Confluence Guard: validates agreement XGBoost + Poisson + Market.
    Returns: (confluence_penalty, confluence_report, analysis_override)
    """
    _confluence_penalty = 0.0
    _confluence_report = {}
    try:
        from confluence_guard import evaluate_confluence as _eval_cg, get_market_implied_probs
        _odds_h = _safe_float(match_obj.get('odds_home'), 0.0)
        _odds_d = _safe_float(match_obj.get('odds_draw'), 0.0)
        _odds_a = _safe_float(match_obj.get('odds_away'), 0.0)
        _p_market = get_market_implied_probs(_odds_h, _odds_d, _odds_a) if _odds_h > 1.0 else None

        _confluence_report = _eval_cg(
            p_xgb=(p_h_xgb, p_d_xgb, p_a_xgb),
            p_poisson=(p_h_poi, p_d_poi, p_a_poi),
            p_market=_p_market,
            momentum_h=h_mom,
            momentum_a=a_mom,
            league_tier=league_tier,
            has_xgb=has_xgb,
            p_external=_get_external_probs(match_obj)
        )
        _confluence_penalty = _confluence_report.get('penalty', 0.0)
        return _confluence_penalty, _confluence_report, _confluence_report.get('reason', '')
    except Exception as _cg_err:
        sys.stderr.write(f"⚠️ [ConfluenceGuard] {_cg_err}\n")
        _xgb_winner = max(('h', p_h_xgb), ('d', p_d_xgb), ('a', p_a_xgb), key=lambda x: x[1])[0]
        _xgb_max_conf = max(p_h_xgb, p_d_xgb, p_a_xgb)
        _poi_winner = max(('h', p_h_poi), ('d', p_d_poi), ('a', p_a_poi), key=lambda x: x[1])[0]
        _xgb_poi_divergence = abs(p_h_xgb - p_h_poi) + abs(p_d_xgb - p_d_poi) + abs(p_a_xgb - p_a_poi)
        if has_xgb and _xgb_winner != _poi_winner:
            if _xgb_max_conf > 0.80:
                _confluence_penalty = 0.15
            else:
                _confluence_penalty = 0.35 if _xgb_poi_divergence > 0.25 else 0.18
        elif has_xgb and _xgb_winner == _poi_winner and _xgb_poi_divergence < 0.10:
            _confluence_penalty = -0.08
        return _confluence_penalty, {}, ""


def calibrate_confidence(p_h, p_d, p_a, selection_prob, composite_confidence,
                         surgical_confidence, confluence_penalty, h_dmf, a_dmf,
                         features, match_obj, style_h_mod, style_a_mod,
                         league_tier, league_name_str, confidence_tag, conf_mod):
    """
    Multi-stage confidence calibration.
    Returns: (confidence, reliability_index, is_value_bet, value_index, analysis)
    """
    analysis = {}
    safe_sel_p = _safe_float(selection_prob, 0.5)

    # Apply Isotonic Calibration to probabilities (if model available)
    if isotonic_calibrate is not None:
        try:
            p_h, p_d, p_a = isotonic_calibrate(p_h, p_d, p_a)
            analysis["IsotonicCalibration"] = "Applied"
        except Exception as e:
            analysis["IsotonicCalibration"] = f"Failed: {e}"

    # Value Index
    odds_h = _safe_float(match_obj.get('odds_home') or match_obj.get('home_odds'), 0.0)
    odds_d = _safe_float(match_obj.get('odds_draw') or match_obj.get('draw_odds'), 0.0)
    odds_a = _safe_float(match_obj.get('odds_away') or match_obj.get('away_odds'), 0.0)
    temp_win_prob = safe_sel_p / 100 if safe_sel_p > 1 else safe_sel_p
    sel_pct = safe_sel_p * 100  # selection_prob est une proba 0-1, seuils en %
    temp_odds = odds_h if sel_pct > 50 else (odds_a if sel_pct < 34 else odds_d)
    value_index = (temp_win_prob * temp_odds)
    
    # Odds Range Filter: Only accept bets with odds between 1.45 and 2.30
    odds_in_range = 1.45 <= temp_odds <= 2.30
    if not odds_in_range:
        analysis["OddsRangeVeto"] = f"Cote {temp_odds:.2f} hors range [1.45, 2.30]"
    
    is_value_bet = value_index > 1.06 and odds_in_range

    # Blend composite confidence with surgical confidence
    confidence = (composite_confidence * 0.6) + (surgical_confidence * 0.4)
    confidence = max(confidence, safe_sel_p * 100 * 0.5)

    # Tactical parity penalty
    p_h_val = _safe_float(p_h, 0.33)
    p_a_val = _safe_float(p_a, 0.33)
    if abs(p_h_val - p_a_val) < 0.05:
        confidence *= 0.95

    # V70 Calibrated Confidence Mapping
    # Échelle proportionnelle à la proba de sélection : les matchs déséquilibrés
    # ne font plus l'objet d'un plancher artificiel ~60.4% → NO BET possible,
    # et les favoris forts plafonnent plus bas (anti-sur-confiance).
    calibrated_base = min(84.0, 28.0 + safe_sel_p * 56.0)
    signal_bonus = 0
    if safe_sel_p > 0.50:
        news_impact = _safe_float(match_obj.get('news_impact', 0), 0.0)
        if news_impact > 0.1: signal_bonus += 2
        if is_value_bet: signal_bonus += 3
        if _safe_float(style_h_mod, 1.0) > 1.05 or _safe_float(style_a_mod, 1.0) > 1.05: signal_bonus += 2
    confidence = max(confidence, calibrated_base + signal_bonus)

    # V25 Motivation Level Filter
    mot_factor = features.get('motivation_context', 1.0)
    if mot_factor != 1.0:
        confidence *= (1.0 + (mot_factor - 1.0) * 0.1)

    # V25 Bayesian Shrinkage for Low-Data Matches (replaces No-History Penalty)
    h_hist_len = features.get('h_hist_len', 0)
    a_hist_len = features.get('a_hist_len', 0)
    n_eff = h_hist_len + a_hist_len
    if n_eff < 30:
        # Prior strength: k=15 for known leagues, k=25 for UNKNOWN/T3
        k = 25 if league_tier in ('UNKNOWN', 'T3') else 15
        shrinkage = n_eff / (n_eff + k) if n_eff > 0 else 0.0
        confidence *= shrinkage
        analysis["BayesianShrinkage"] = f"Shrinkage: {shrinkage:.2f} (n_eff={n_eff}, k={k}, tier={league_tier})"

    # V26 Reliability Index
    completeness = features.get('data_completeness', 50.0)
    liquidity = features.get('liquidity_index', 0.5)
    confirmed = features.get('v26_lineups_confirmed', 0.0)
    reliability_index = (completeness * 0.3) + (liquidity * 10.0)
    if confirmed > 0:
        reliability_index += 60.0
    else:
        reliability_index = min(45.0, reliability_index)

    # V26 Tactical Integrity Sentinel (Trap Detection)
    mom_trend = features.get('v26_momentum_trend', 0.0)
    odds_h_open = _safe_float(match_obj.get('odds_home_open') or match_obj.get('odds_home'), odds_h)
    odds_a_open = _safe_float(match_obj.get('odds_away_open') or match_obj.get('odds_away'), odds_a)
    odds_drop_h = (odds_h_open - odds_h) / odds_h_open if odds_h_open > 0 else 0
    odds_drop_a = (odds_a_open - odds_a) / odds_a_open if odds_a_open > 0 else 0

    if odds_drop_h > 0.15 and mom_trend < -10:
        confidence *= 0.85
        analysis["Trap_A"] = "⚠️ V26 ALERT: Piège de marché détecté. Chute de cote Home sans pression offensive."
    if odds_drop_a > 0.15 and mom_trend > 10:
        confidence *= 0.85
        analysis["Trap_B"] = "⚠️ V26 ALERT: Piège de marché détecté. Chute de cote Away sans pression offensive."

    # V70 & TIER LOGIC Volatility Penalty
    if league_tier == 'T3':
        confidence *= 0.80
        confidence = min(64.5, confidence)
        analysis["Volatility"] = {
            "score": 50,
            "reason": f"⚠️ TIER 3 VOLATILITY: البطولة '{league_name_str}' تفتقر لاستقرار البيانات. تم تخفيض الثقة بنسبة 20% لتجنب المخاطرة."
        }
    else:
        league_name_context = match_obj.get('league') or match_obj.get('tournament_name', '')
        volatility_penalty, is_volatile_league = get_league_volatility_penalty(league_name_context)
        if volatility_penalty > 0:
            confidence -= volatility_penalty
            if is_volatile_league:
                confidence = min(79.0, confidence)
                analysis["Volatility"] = {
                    "score": int(100 - volatility_penalty),
                    "reason": f"⚠️ Volatility Alert: {league_name_context}. Confiance bridée à {int(confidence)}% max."
                }

    # V90 Adaptive Learning Engine
    adaptive_adj = float(match_obj.get('adaptive_confidence_adj', 0.0))
    if adaptive_adj != 0:
        confidence += adaptive_adj
        analysis["Adaptive_AI"] = {
            "score": int(max(0, min(100, 100 + adaptive_adj))),
            "reason": f"🧠 Cerveau Adaptatif: Correction automatique ({adaptive_adj:+.1f}%) appliquée suite aux biais historiques de cette ligue."
        }

    # Confidence Tag modulation
    CONF_TAG_ADJ = {'HIGH': 3.0, 'MEDIUM': 0.0, 'LOW': -8.0, 'EXCLUDED': -100.0}
    ct_adj = CONF_TAG_ADJ.get(confidence_tag, -8.0)
    if ct_adj != 0:
        analysis["LeagueConfidenceTag"] = f"{confidence_tag} ({ct_adj:+.0f}%)"
    confidence += ct_adj

    # Final Safety Clamp
    confidence = max(0.1, min(100.0, confidence + conf_mod))

    # Confluence penalty
    if confluence_penalty != 0.0:
        confidence *= (1.0 - confluence_penalty)
        confidence = max(5.0, min(99.0, confidence))

    return confidence, reliability_index, is_value_bet, value_index, analysis


def apply_draw_and_world_cup(p_h, p_d, p_a, league_name_str, tourn_name_str, features, analysis):
    """Apply draw multiplier and World Cup FIFA rank logic."""
    draw_mult = get_league_draw_multiplier(None, None, league_name=league_name_str)
    p_d_raw = p_d
    p_d = min(0.60, p_d * draw_mult)
    total = p_h + p_d + p_a
    p_h /= total
    p_d /= total
    p_a /= total
    if p_d != p_d_raw:
        analysis["DrawCorrection"] = f"Draw post-proc: mult={draw_mult:.3f}, {p_d_raw:.1%}->{p_d:.1%}"

    is_wc = 'world cup' in league_name_str or 'fifa' in league_name_str
    confidence_adj = 0.0
    if is_wc:
        rank_h = features.get('fifa_rank_h', 999)
        rank_a = features.get('fifa_rank_a', 999)
        has_rank = rank_h < 999 and rank_a < 999

        if has_rank:
            rank_diff = rank_a - rank_h
            if abs(rank_diff) > 10:
                winner_idx = 0 if rank_diff > 0 else 2
                boost = min(0.25, abs(rank_diff) / 150.0)
                outcomes_probs = [p_h, p_d, p_a]
                outcomes_probs[winner_idx] = min(0.85, outcomes_probs[winner_idx] + boost)
                outcomes_probs[1 - winner_idx] = max(0.02, outcomes_probs[1 - winner_idx] - boost * 0.75)
                total = sum(outcomes_probs)
                p_h, p_d, p_a = [x / total for x in outcomes_probs]
                analysis["FIFARankBoost"] = f"{'Home' if rank_diff > 0 else 'Away'} +{boost:.1%} (rank diff={abs(rank_diff)})"

            if abs(rank_diff) < 15:
                p_d_raw2 = p_d
                p_d = min(0.50, p_d * 1.15)
                total = p_h + p_d + p_a
                p_h /= total; p_d /= total; p_a /= total
                if p_d != p_d_raw2:
                    analysis["WCGroupDrawBoost"] = f"Close ranks: {p_d_raw2:.1%}->{p_d:.1%}"

        is_knockout = any(k in tourn_name_str for k in ['round of 16', 'quarter', 'semi', 'final', 'knockout', 'round 16', 'round_16'])
        if is_knockout:
            confidence_adj -= 3.0
            analysis["WCKnockout"] = "KO match: confidence -3%"
        else:
            confidence_adj -= 1.0
            analysis["WCGroupStage"] = "Group: confidence -1% (variance)"

    return p_h, p_d, p_a, confidence_adj


def determine_verdict(confidence, p_d, confluence_penalty, is_value_bet=False, value_index=0.0):
    """Determine the base verdict from confidence and draw probability."""
    if confluence_penalty >= 0.35: return "NO BET"
    elif confidence < 55: return "NO BET"
    elif confidence < 70: return "RISKY"
    elif p_d > 0.40: return "DRAW TRAP"
    # Reject value bet if confidence too low (Phase 3: min 60% for value bets)
    if is_value_bet and confidence < 60:
        return "NO BET (LOW_CONF_VALUE)"
    return "SAFE BET"


def assess_risk(league_tier, h_dmf, a_dmf, h_is_dz, a_is_dz,
                odds_h, odds_d, odds_a, odds_h_open, odds_a_open,
                p_h, p_a, features, confidence, match_obj=None):
    """
    V80 Match Integrity & Risk Detection (8 rules - added Rule 8 Steam Drift).
    Returns: (risk_score, risk_reasons, is_suspicious_flag, is_safe_bet_flag)
    """
    risk_score = 0
    risk_reasons = []

    # Rule 1: Tier 3 or Unknown
    if league_tier in ['T3', 'UNKNOWN']:
        risk_score += 5
        risk_reasons.append("البطولة تفتقر للاستقرار الإحصائي المستمر (Tier 3/Unknown).")

    # Rule 2: Dead Zone
    safe_h_dmf = float(h_dmf)
    safe_a_dmf = float(a_dmf)
    if safe_h_dmf < 0.9 and safe_a_dmf < 0.9:
        risk_score += 4
        risk_reasons.append("لا يوجد حافز قوي لكلا الفريقين للعب بجدية (Dead Zone).")

    # Rule 3: Motivation Collision
    if (safe_h_dmf > 1.25 and a_is_dz) or (safe_a_dmf > 1.25 and h_is_dz):
        risk_score += 3
        risk_reasons.append("تضارب في الحوافز: فريق يقاتل من أجل النقاط ضد فريق في منطقة الأمان (Potential Surprise).")

    # Rule 4: Market Integrity
    o_drop_h = (odds_h_open - odds_h) / odds_h_open if odds_h_open > 0 else 0
    o_drop_a = (odds_a_open - odds_a) / odds_a_open if odds_a_open > 0 else 0
    if (o_drop_h > 0.25 and p_h < 0.35) or (o_drop_a > 0.25 and p_a < 0.35):
        risk_score += 6
        risk_reasons.append("🚨 تحذير: حركة مريبة في السوق (Steam Move) لصالح الفريق غير المرشح.")

    # Rule 5: Missing Data
    comp_score = features.get('data_completeness', 100)
    if comp_score < 60.0:
        risk_score += 3
        risk_reasons.append(f"البيانات متقطعة والمباراة تفتقر للعمق الإحصائي (Completeness: {comp_score:.1f}%).")

    # Rule 6: Integrity Sentinel
    if league_tier == 'T3' and (o_drop_h > 0.15 or o_drop_a > 0.15):
        risk_score += 4
        risk_reasons.append("تنبيه: انخفاض مريب في الاحتمالات في دوري منخفض التصنيف (High Integrity Risk).")

    # Rule 7: Extreme Odds Movement (Steam) on favorite
    max_drop = max(o_drop_h, o_drop_a)
    if max_drop > 0.30:
        risk_score += 4
        risk_reasons.append(f"⚡ حركة حادة في الأودز (Steam >30%): السوق يتفاعل بقوة.")

    # Rule 8: Steam Drift >10% within 12h before kickoff
    if match_obj:
        ts = _safe_float(match_obj.get('startTimestamp', 0))
        if ts > 0:
            import time
            hours_to_kickoff = max(0, (ts - time.time()) / 3600.0)
            if hours_to_kickoff <= 12:
                max_change = max(abs(o_drop_h), abs(o_drop_a))
                if max_change > 0.10:
                    risk_score += 10
                    risk_reasons.append(f"🛑 STEAM DRIFT VETO: تغير الأودز >10% في آخر {hours_to_kickoff:.1f}h — مخاطرة عالية.")

    is_suspicious_flag = bool(risk_score >= 8)
    is_safe_bet_flag = bool(confidence > 80.0 and league_tier == 'T1' and risk_score < 3)

    return risk_score, risk_reasons, is_suspicious_flag, is_safe_bet_flag


def apply_veto_shield(risk_score, confidence, reliability_index, data_completeness_score,
                      league_tier, match_obj, confidence_threshold=15.0):
    """
    Apply veto shield logic. Returns: (no_bet, verdict, zero_failure_veto, shield_reason)
    """
    zero_failure_veto = False
    shield_reason = ""

    # Tiered Confidence Pre-Match Filter
    if confidence < confidence_threshold:
        return True, "NO BET", True, f"Extreme Low Confidence ({confidence:.1f}% < {confidence_threshold:.1f}%)"

    # Risk Score Veto
    if risk_score >= 15:
        zero_failure_veto = True
        shield_reason = f"🛡️ VETO SÉCURITÉ: Risque critique ({risk_score})."

    # Reliability Index Veto
    current_conf = confidence
    reliability_index_calc = (current_conf * 0.7) + (data_completeness_score * 0.3)
    if reliability_index_calc < 25.0:
        zero_failure_veto = True
        shield_reason = "🛡️ VETO DONNÉES: Manque de profondeur."

    if zero_failure_veto and not match_obj.get('force_predict'):
        return True, "NO BET (SHIELDED)", zero_failure_veto, shield_reason

    return False, None, zero_failure_veto, shield_reason


def build_analysis_report(features, home_name, away_name, selection, selection_label,
                          h_mom, a_mom, h_roll_p3, a_roll_p3, perf_delta_h, perf_delta_a,
                          xg_h, xg_a, style_h_mod, style_a_mod, h_style, a_style,
                          h_dmf, a_dmf, motivation_signature, h_is_dz, a_is_dz,
                          total_absentee_impact, is_smart_money, odds_drop_pct,
                          value_index, confidence, ref_name, selection_prob, features_dict):
    """Build the 10-point expert analysis report."""
    analysis = {}

    h_form_score = (h_mom * 10) + (h_roll_p3 * 20)
    a_form_score = (a_mom * 10) + (a_roll_p3 * 20)

    analysis["1_Form"] = {
        "score": int(max(h_form_score, a_form_score)),
        "reason": f"Momentum: {home_name} ({h_mom:.1f}) vs {away_name} ({a_mom:.1f}). " +
                  (f"QoP (xG-Elo) Delta {perf_delta_h:+.2f} {home_name}." if abs(perf_delta_h) > 0.1 else f"Dynamique stable ({selection_label}).")
    }

    h2h_h_mod, _ = get_h2h_modifier(home_name, away_name)
    analysis["2_H2H"] = {
        "score": int(features_dict.get('h2h_win_rate', 0)),
        "reason": f"Historique: {int(features_dict.get('h2h_games', 0))} rencontres. Taux de victoire {home_name}: {features_dict.get('h2h_win_rate', 0):.0f}%. " +
                  ("Domination tactique historique confirmée." if h2h_h_mod > 1.05 else "Historique équilibré.")
    }

    analysis["3_xG"] = {
        "score": int(selection_prob * 100),
        "reason": f"Offensive xG: {xg_h:.2f} (H) vs {xg_a:.2f} (A). Qualité de tir supérieure pour {selection_label}."
    }

    analysis["4_Players"] = {
        "score": 100 - int(features_dict.get('home_injury_impact', 0) * 10),
        "reason": (f"Impact absences: -{int(total_absentee_impact*100)}%. " if total_absentee_impact > 0 else "Effectifs au complet. ") +
                  f"Sentiment global: {float(features_dict.get('news_sentiment', 0)):+.1f}."
    }

    fav_team_tactics = home_name if style_h_mod > style_a_mod else (away_name if style_a_mod > style_h_mod else "Standard")
    analysis["5_Tactics"] = {
        "score": 75 + int(max(style_h_mod, style_a_mod) * 10 - 10),
        "reason": f"Style: {h_style} vs {a_style}. Intensité de pressing: Moderate. Avantage {fav_team_tactics} sur les transitions."
    }

    analysis["6_Market"] = {
        "score": int(odds_drop_pct * 100) if is_smart_money else 50,
        "reason": f"Indice de valeur: {value_index:.2f}. " +
                  (f"Alerte Smart Money: Chute de {int(odds_drop_pct*100)}% sur {selection}." if is_smart_money else "Mouvements de marché stables.")
    }

    analysis["7_Context"] = {
        "score": int(min(100, max(h_dmf, a_dmf) * 60)),
        "reason": f"Hafiz DMF: {h_dmf:.2f} (H) / {a_dmf:.2f} (A). Signature: {motivation_signature}. " +
                  ("Pression tactique liée au classement.") +
                  (f" Dead Zone détectée ({home_name if h_is_dz else away_name})." if (h_is_dz or a_is_dz) else "")
    }

    analysis["8_External"] = {
        "score": 80,
        "reason": f"Météo: {features_dict.get('weather_temp', 'N/A')}°C. Arbitre: {ref_name if ref_name else 'Standard'}. Conditions de jeu optimales."
    }

    analysis["9_Metrics"] = {
        "score": int(features_dict.get('h_pass_acc', 80)),
        "reason": f"Efficacité xG: {perf_delta_h:+.2f} (H) vs {perf_delta_a:+.2f} (A). " +
                  f"Big Chances: {features_dict.get('h_bc', 0):.1f} vs {features_dict.get('a_bc', 0):.1f}."
    }

    analysis["10_Smart_Indicators"] = {
        "score": 90 if confidence > 80 else 60,
        "reason": f"Confiance Simulation MC: {int(confidence)}%. " +
                  ("Signal WHALE détecté: Flux de paris massif sur cet outcome." if confidence > 80 and is_smart_money else "Flux de paris équilibré.")
    }

    return analysis


def apply_post_verdict(confidence, surgical_confidence, value_index, league_tier, analysis):
    """Apply final verdict override (SURGICAL STRIKE, etc.)."""
    verdict = "SAFE BET"
    if confidence >= 82: verdict = "SAFE BET"
    elif confidence >= 60: verdict = "STRONG BET"
    else: verdict = "RISKY BET"

    # Phase 3: Reject value bet if confidence < 60
    is_value_bet = value_index > 1.06
    if is_value_bet and confidence < 60:
        verdict = "NO BET (LOW_CONF_VALUE)"
        analysis["LowConfValueVeto"] = f"Value bet rejected: confidence {confidence:.1f}% < 60%"

    # V98 SURGICAL STRIKE
    if confidence > 88 and value_index > 1.15 and league_tier == 'T1':
        verdict = "💎 SURGICAL STRIKE"
        analysis["Surgical_Strike"] = "🚨 SURGICAL STRIKE: تم اكتشاف فرصة نادرة تجمع بين دقة تنبؤ هائلة وقيمة سوقية عالية جداً."

    return verdict
