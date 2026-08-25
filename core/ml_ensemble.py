"""
ml_ensemble.py — XGBoost Model Chain, Ensemble Blending & SHAP Explainability
Extracted from prediction_engine.py (Lines 570-800)

Responsibilities:
  1. Select best available booster (V553 premium → V553 → V552 → V551 → V55 → Titanium → Legacy)
  2. Run XGBoost inference + Monte Carlo simulation
  3. Blend with Poisson via league weight matrix
  4. Apply V4 ensemble, PredixSport external blend
  5. Neural Meta-Refiner bias correction
  6. SHAP-Lite explainability
"""
import sys
import os
import json
import numpy as np

_DYNAMIC_WEIGHTS_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'league_dynamic_weights.json')
_DYNAMIC_WEIGHTS_CACHE = None
_DYNAMIC_WEIGHTS_TS = 0

_CALIBRATION_WEIGHTS_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'calibration_weights.json')
_CALIBRATION_WEIGHTS_CACHE = None
_CALIBRATION_WEIGHTS_TS = 0


def _load_dynamic_weights():
    """Load per-league dynamic weights from backtest results (refreshed every 6h)."""
    global _DYNAMIC_WEIGHTS_CACHE, _DYNAMIC_WEIGHTS_TS
    now = __import__('time').time()
    if _DYNAMIC_WEIGHTS_CACHE is not None and (now - _DYNAMIC_WEIGHTS_TS) < 21600:
        return _DYNAMIC_WEIGHTS_CACHE
    try:
        with open(_DYNAMIC_WEIGHTS_PATH, 'r') as f:
            _DYNAMIC_WEIGHTS_CACHE = json.load(f)
            _DYNAMIC_WEIGHTS_TS = now
    except FileNotFoundError:
        sys.stderr.write(
            "[WARN] league_dynamic_weights.json missing — auto-backtest never ran. "
            "Run `node services/autoBacktestService.js` or the daily cron before expecting feedback.\n"
        )
        _DYNAMIC_WEIGHTS_CACHE = {}
        _DYNAMIC_WEIGHTS_TS = now
    except Exception:
        _DYNAMIC_WEIGHTS_CACHE = {}
        _DYNAMIC_WEIGHTS_TS = now
    return _DYNAMIC_WEIGHTS_CACHE


def _load_calibration_weights():
    """Load per-league calibration weights from Brier/LogLoss feedback (refreshed every 6h)."""
    global _CALIBRATION_WEIGHTS_CACHE, _CALIBRATION_WEIGHTS_TS
    now = __import__('time').time()
    if _CALIBRATION_WEIGHTS_CACHE is not None and (now - _CALIBRATION_WEIGHTS_TS) < 21600:
        return _CALIBRATION_WEIGHTS_CACHE
    try:
        with open(_CALIBRATION_WEIGHTS_PATH, 'r') as f:
            _CALIBRATION_WEIGHTS_CACHE = json.load(f)
            _CALIBRATION_WEIGHTS_TS = now
    except FileNotFoundError:
        sys.stderr.write(
            "[WARN] calibration_weights.json missing — run `python core/backtest_feedback.py` "
            "after the auto-backtest has written calibration_metrics.json.\n"
        )
        _CALIBRATION_WEIGHTS_CACHE = {}
        _CALIBRATION_WEIGHTS_TS = now
    except Exception:
        _CALIBRATION_WEIGHTS_CACHE = {}
        _CALIBRATION_WEIGHTS_TS = now
    return _CALIBRATION_WEIGHTS_CACHE


def _get_league_weights(league_name):
    """Merge static matrix, dynamic backtest weights, and calibration feedback."""
    static = LEAGUE_WEIGHT_MATRIX.get("DEFAULT", {"xgb_weight": 0.75, "news_boost": 0.30})

    # Source 1: Dynamic weights from binary accuracy backtest
    dynamic = _load_dynamic_weights().get(league_name)
    if dynamic:
        model_edge = dynamic.get('edge', 0) or 0
        if model_edge > 3:
            static = {
                "xgb_weight": dynamic.get('xgb_weight', static['xgb_weight']),
                "news_boost": dynamic.get('news_boost', static['news_boost']),
            }

    # Source 2: Calibration weights from Brier/LogLoss feedback
    cal = _load_calibration_weights().get(league_name)
    if cal and cal.get('confidence', 0) > 0.3:
        xgb_adj = cal.get('xgb_adjustment', 0.0)
        # Apply calibration adjustment (clamped to [0.3, 0.98])
        new_xgb = max(0.30, min(0.98, static['xgb_weight'] + xgb_adj))
        static = {
            "xgb_weight": round(new_xgb, 4),
            "news_boost": static['news_boost'],
            "_calibration": cal.get('quality', 'unknown'),
            "_brier": cal.get('brier1x2'),
        }

    return static


from ml_features import (
    FEATURE_NAMES_V53, FEATURE_NAMES_V54, FEATURE_NAMES_V55,
    FEATURE_NAMES_V551, FEATURE_NAMES_V552, FEATURE_NAMES_V553,
    FEATURE_NAMES_V56, FEATURE_NAMES_TITANIUM, FEATURE_NAMES,
    extract_v56_features,
)
from meta_refiner import refine_prediction
from model_manager import (
    get_xgb, get_titanium_booster, get_titanium_v4_booster,
    get_v55_booster, get_v551_booster, get_v552_booster,
    get_v553_booster, get_v553_premium_booster, get_v56_booster,
    get_main_booster, get_corners_model, get_cards_model,
    simulate_match_mc,
)
from feature_engineer import extract_v4_features, FEATURE_NAMES_V4
from data_loader import safe_float as _safe_float

# V102 League Strategy Matrix (kept here for ensemble blending)
LEAGUE_WEIGHT_MATRIX = {
    "Premier League": {"xgb_weight": 0.95, "news_boost": 0.15},
    "LaLiga": {"xgb_weight": 0.92, "news_boost": 0.25},
    "Serie A": {"xgb_weight": 0.88, "news_boost": 0.30},
    "Bundesliga": {"xgb_weight": 0.90, "news_boost": 0.15},
    "Ligue 1": {"xgb_weight": 0.85, "news_boost": 0.35},
    "Primeira Liga": {"xgb_weight": 0.82, "news_boost": 0.45},
    "Eredivisie": {"xgb_weight": 0.88, "news_boost": 0.20},
    "Saudi Pro League": {"xgb_weight": 0.65, "news_boost": 0.65},
    "Stoiximan Super League": {"xgb_weight": 0.55, "news_boost": 0.75},
    "T1": {"xgb_weight": 0.90, "news_boost": 0.20},
    "T2": {"xgb_weight": 0.70, "news_boost": 0.45},
    "T3": {"xgb_weight": 0.45, "news_boost": 0.85},
    # Additional leagues
    "Championship": {"xgb_weight": 0.80, "news_boost": 0.20},
    "Champions League": {"xgb_weight": 0.92, "news_boost": 0.10},
    "Europa League": {"xgb_weight": 0.85, "news_boost": 0.20},
    "Conference League": {"xgb_weight": 0.75, "news_boost": 0.25},
    "Serie B": {"xgb_weight": 0.70, "news_boost": 0.30},
    "LaLiga2": {"xgb_weight": 0.70, "news_boost": 0.30},
    "Ligue 2": {"xgb_weight": 0.68, "news_boost": 0.30},
    "2. Bundesliga": {"xgb_weight": 0.78, "news_boost": 0.20},
    "EFL League One": {"xgb_weight": 0.60, "news_boost": 0.35},
    "EFL League Two": {"xgb_weight": 0.55, "news_boost": 0.40},
    "Scottish Premiership": {"xgb_weight": 0.72, "news_boost": 0.25},
    "Eredivisie 2": {"xgb_weight": 0.65, "news_boost": 0.30},
    "Belgian Pro League": {"xgb_weight": 0.70, "news_boost": 0.30},
    "Super Lig": {"xgb_weight": 0.68, "news_boost": 0.40},
    "Eredivisie": {"xgb_weight": 0.88, "news_boost": 0.20},
    "MLS": {"xgb_weight": 0.60, "news_boost": 0.50},
    "Brazil Serie A": {"xgb_weight": 0.70, "news_boost": 0.35},
    "Argentina Primera": {"xgb_weight": 0.60, "news_boost": 0.50},
    "Liga MX": {"xgb_weight": 0.68, "news_boost": 0.40},
    "J1 League": {"xgb_weight": 0.60, "news_boost": 0.45},
    "K League 1": {"xgb_weight": 0.62, "news_boost": 0.40},
    "A-League": {"xgb_weight": 0.55, "news_boost": 0.50},
    "Indian Super League": {"xgb_weight": 0.50, "news_boost": 0.55},
    "Liga Portugal": {"xgb_weight": 0.78, "news_boost": 0.25},
    "Allsvenskan": {"xgb_weight": 0.65, "news_boost": 0.30},
    "Eliteserien": {"xgb_weight": 0.62, "news_boost": 0.35},
    "Veikkausliiga": {"xgb_weight": 0.55, "news_boost": 0.45},
    "Superettan": {"xgb_weight": 0.50, "news_boost": 0.50},
    "1. Liga": {"xgb_weight": 0.60, "news_boost": 0.35},
    "WC2026": {"xgb_weight": 0.95, "news_boost": 0.10},
    "International": {"xgb_weight": 0.80, "news_boost": 0.15},
    "Friendlies": {"xgb_weight": 0.30, "news_boost": 0.10},
    "DEFAULT": {"xgb_weight": 0.75, "news_boost": 0.30}
}


def _feature_count(booster):
    """Return the expected feature count of a booster, or None if unknown."""
    try:
        n = getattr(booster, 'num_features', None)
        if callable(n):
            n = n()
        if isinstance(n, str):
            n = int(n)
        return n
    except Exception:
        return None


def _candidate_ok(booster, feature_vector):
    """A candidate is usable only when its feature count matches the vector.

    Some models were trained with a different feature list than the current
    inference lists (V553/TITANIUM drift). Feeding a mismatched vector to
    xgboost silently misbehaves, so we skip such boosters and fall through to
    the next matching model in the chain instead of dropping to Poisson-only.
    """
    if booster is None or not feature_vector:
        return False
    n = _feature_count(booster)
    if n is None:
        return True  # cannot verify — assume compatible
    return n == len(feature_vector)


def select_model_booster(features, league_tier, match_obj=None):
    """
    Select the best available XGBoost booster from the fallback chain.
    Returns: (active_feature_names, active_feature_vector, ai_source, XGB_BOOSTER)
    """
    V553_PREMIUM_BOOSTER = get_v553_premium_booster()
    V553_BOOSTER = get_v553_booster()
    V552_BOOSTER = get_v552_booster()
    V551_BOOSTER = get_v551_booster()
    V55_BOOSTER = get_v55_booster()
    V56_BOOSTER = get_v56_booster()
    TITANIUM_BOOSTER = get_titanium_booster()
    MAIN_BOOSTER = get_main_booster()

    EXCLUDED_FEATURES = {'draw_deadlock', 'draw_defensive_eq'}

    is_wc2026_match = (V553_PREMIUM_BOOSTER is not None or V553_BOOSTER is not None) and features.get('fifa_rank_h', 999) < 999 and features.get('fifa_rank_a', 999) < 999

    candidates = []
    if is_wc2026_match:
        v553_names = [f for f in FEATURE_NAMES_V553 if f not in EXCLUDED_FEATURES]
        if V553_PREMIUM_BOOSTER is not None:
            candidates.append((v553_names, [float(features.get(f, 0)) for f in v553_names], V553_PREMIUM_BOOSTER, "V553-PREMIUM"))
        if V553_BOOSTER is not None:
            candidates.append((v553_names, [float(features.get(f, 0)) for f in v553_names], V553_BOOSTER, "V553-WC2026"))
    if V552_BOOSTER is not None:
        v552_names = [f for f in FEATURE_NAMES_V552 if f not in EXCLUDED_FEATURES]
        candidates.append((v552_names, [float(features.get(f, 0)) for f in v552_names], V552_BOOSTER, "V552-CHRONO-2026"))
    if V551_BOOSTER is not None:
        candidates.append((FEATURE_NAMES_V551, [float(features.get(f, 0)) for f in FEATURE_NAMES_V551], V551_BOOSTER, "V551-PRUNED+2010"))
    if V55_BOOSTER is not None:
        candidates.append((FEATURE_NAMES_V55, [float(features.get(f, 0)) for f in FEATURE_NAMES_V55], V55_BOOSTER, "V55-OPTIMIZED"))
    if V56_BOOSTER is not None:
        v56_vector = extract_v56_features(match_obj if match_obj else features.get('__raw_row__', features))
        candidates.append((FEATURE_NAMES_V56, v56_vector, V56_BOOSTER, "V56-RETRAINED"))
    if TITANIUM_BOOSTER is not None:
        candidates.append((FEATURE_NAMES_TITANIUM, [float(features.get(f, 0)) for f in FEATURE_NAMES_TITANIUM], TITANIUM_BOOSTER, "TITANIUM-ELITE-V3"))
    if MAIN_BOOSTER is not None:
        candidates.append((FEATURE_NAMES_V54, [float(features.get(f, 0)) for f in FEATURE_NAMES_V54], MAIN_BOOSTER, "V54"))

    # Pick the first candidate whose feature count matches its model.
    for names, vector, booster, source in candidates:
        if _candidate_ok(booster, vector):
            return names, vector, source, booster

    # None matched — keep legacy behaviour (first available booster; the
    # caller's mismatch guard will still route to Poisson-only).
    if candidates:
        return candidates[0][0], candidates[0][1], candidates[0][3], candidates[0][2]

    active_feature_names = FEATURE_NAMES
    active_feature_vector = [float(features.get(f, 0)) for f in FEATURE_NAMES]
    return active_feature_names, active_feature_vector, None, None


def _get_league_draw_base_rate(league_name):
    """
    Empirical league draw base rate from archive_football_data (league_code match).
    Used by the draw dampener to correct systematic draw over-prediction.
    Returns a float in (0, 1); falls back to 0.27 when unknown.
    """
    try:
        import sqlite3
        _cache = getattr(_get_league_draw_base_rate, '_draw_cache', None)
        if _cache is None:
            _cache = {}
            _get_league_draw_base_rate._draw_cache = _cache
        if league_name in _cache:
            return _cache[league_name]
        db_path = os.path.join(os.path.dirname(__file__), '..', 'data', 'historical_archive.sqlite')
        if not os.path.exists(db_path):
            return 0.27
        conn = sqlite3.connect(db_path)
        code = _league_name_to_code(str(league_name))
        q = "SELECT COUNT(*), SUM(CASE WHEN score_home = score_away THEN 1.0 ELSE 0 END) FROM archive_football_data WHERE score_home IS NOT NULL AND score_away IS NOT NULL"
        params = []
        if code:
            q += " AND league_code = ?"
            params.append(code)
        row = conn.execute(q, params).fetchone()
        conn.close()
        rate = 0.27
        if row and row[0] and row[0] > 200:
            rate = float(row[1]) / float(row[0])
            rate = max(0.20, min(0.40, rate))
        _cache[league_name] = rate
        return rate
    except Exception:
        import traceback
        sys.stderr.write(f"[DrawBaseRate] error: {traceback.format_exc()}\n")
        return 0.27


def _league_name_to_code(league_name):
    """Map common league display names to football-data.co.uk league codes."""
    ln = (league_name or '').lower()
    mapping = {
        'premier league': 'E0', 'england': 'E0',
        'la liga': 'SP1', 'laliga': 'SP1', 'spain': 'SP1', 'liga': 'SP1',
        'serie a': 'I1', 'italy': 'I1',
        'bundesliga': 'D1', 'germany': 'D1',
        'ligue 1': 'F1', 'france': 'F1',
    }
    for key, code in mapping.items():
        if key in ln:
            return code
    return None


def apply_draw_dampener(p_h, p_d, p_a, league_name, base_rate=None):
    """
    Post-hoc correction for systematic draw over-prediction in trained XGB models.
    If the model's draw probability exceeds the empirical league draw rate by a
    wide margin, pull it down toward the base rate and redistribute the excess
    to home/away proportionally to their current mass.
    Returns (p_h, p_d, p_a) normalized.
    """
    try:
        if base_rate is None:
            base_rate = _get_league_draw_base_rate(league_name)
        base_rate = max(0.20, min(0.40, float(base_rate)))
        s = p_h + p_d + p_a
        if s <= 0:
            return p_h, p_d, p_a
        p_h, p_d, p_a = p_h / s, p_d / s, p_a / s

        # Only act when the model is clearly over-confident on draws.
        # Excess beyond 1.35x the base rate is treated as model noise.
        excess = p_d - base_rate
        if excess <= 0:
            return p_h, p_d, p_a

        max_allowed = base_rate * 1.35
        if p_d <= max_allowed:
            return p_h, p_d, p_a

        dampened_d = max_allowed
        removed = p_d - dampened_d

        hw = p_h + p_a
        if hw > 0:
            p_h += removed * (p_h / hw)
            p_a += removed * (p_a / hw)
        p_d = dampened_d

        s2 = p_h + p_d + p_a
        return p_h / s2, p_d / s2, p_a / s2
    except Exception:
        return p_h, p_d, p_a


def meta_refiner_python_enabled() -> bool:
    """Garde du 1er application Python du Meta-Refiner (NeuralMetaRefiner).

    Par défaut OFF : on garde UNE SEULE correction (celle JS post-moteur, mesurée
    par settlement/backtest). Activer via META_REFINER_PY=on pour restaurer le
    comportement legacy (3 corrections empilées = sur-lissage bayésien).
    """
    return os.environ.get("META_REFINER_PY", "off").lower() == "on"


def run_xgboost_inference(active_feature_vector, active_feature_names, XGB_BOOSTER,
                           sim, features, match_obj, league_name, league_tier):
    """
    Run XGBoost Monte Carlo simulation and blend with Poisson.
    Returns: dict with p_h_xgb, p_d_xgb, p_a_xgb, p_h_ai, p_d_ai, p_a_ai,
             has_xgb, ai_source, explainer_data, analysis
    """
    analysis = {}
    p_h_poi, p_d_poi, p_a_poi = sim['p_h'], sim['p_d'], sim['p_a']
    p_h_xgb, p_d_xgb, p_a_xgb = p_h_poi, p_d_poi, p_a_poi
    p_h_ai, p_d_ai, p_a_ai = p_h_poi, p_d_poi, p_a_poi
    ai_source = "Standard-Poisson"
    has_xgb = False
    explainer_data = []

    if not XGB_BOOSTER:
        return {
            'p_h_xgb': p_h_xgb, 'p_d_xgb': p_d_xgb, 'p_a_xgb': p_a_xgb,
            'p_h_ai': p_h_ai, 'p_d_ai': p_d_ai, 'p_a_ai': p_a_ai,
            'has_xgb': False, 'ai_source': "Poisson-Tactical-V11 (AI Offline)",
            'explainer_data': [], 'analysis': {}
        }

    try:
        expected_features = getattr(XGB_BOOSTER, 'num_features', lambda: len(active_feature_vector))()
        if len(active_feature_vector) != expected_features:
            print(f'[PRED-ENGINE] WARN: Feature vector mismatch: expected {expected_features}, got {len(active_feature_vector)} — falling back to Poisson')
            ai_source = "Poisson-only (feature mismatch)"
        else:
            fatigue = (features.get('h_fatigue_cumulative', 1.0), features.get('a_fatigue_cumulative', 1.0))
            injuries = (features.get('home_injury_impact', 0.0), features.get('away_injury_impact', 0.0))
            _mc_sims = 1000 if injuries[0] >= 3.0 or injuries[1] >= 3.0 else 500
            mc_result = simulate_match_mc(
                XGB_BOOSTER,
                active_feature_vector,
                num_simulations=_mc_sims,
                feature_names=active_feature_names,
                fatigue_impact=fatigue,
                injury_impact=injuries,
                league_name=league_name
            )

            if mc_result[0] is not None:
                p_h_xgb, p_d_xgb, p_a_xgb = mc_result

                # Market Psychology Layer
                odds_h = _safe_float(match_obj.get('odds_home'), 2.0)
                implied_h = 1.0 / odds_h if odds_h > 0 else 0.33
                n_sent = _safe_float(features.get('news_sent'), 0)

                if p_h_xgb > (implied_h + 0.15) and n_sent < -0.2:
                    p_h_xgb *= 0.85

                # Dynamic weight lookup: backtest-adjusted overrides static matrix
                l_strat = _get_league_weights(league_name)
                # Fallback: static matrix exact match
                if l_strat is None or l_strat == LEAGUE_WEIGHT_MATRIX.get("DEFAULT"):
                    l_strat = LEAGUE_WEIGHT_MATRIX.get(league_name) or l_strat
                # Fuzzy match
                if not l_strat:
                    ln_lower = league_name.lower()
                    for key, val in LEAGUE_WEIGHT_MATRIX.items():
                        if key.lower() in ln_lower or ln_lower in key.lower():
                            l_strat = val
                            break
                if not l_strat:
                    l_strat = LEAGUE_WEIGHT_MATRIX.get(league_tier, LEAGUE_WEIGHT_MATRIX['DEFAULT'])
                w_xgb = l_strat['xgb_weight']
                w_poi = 1.0 - w_xgb

                p_h_ai = (p_h_xgb * w_xgb) + (p_h_poi * w_poi)
                p_d_ai = (p_d_xgb * w_xgb) + (p_d_poi * w_poi)
                p_a_ai = (p_a_xgb * w_xgb) + (p_a_poi * w_poi)

                has_xgb = True

                # V102 News Intelligence Injection
                if n_sent != 0:
                    n_boost = l_strat['news_boost'] * n_sent
                    p_h_ai = max(0.01, min(0.95, p_h_ai * (1.0 + n_boost)))

                # Draw Dampener: correct systematic draw over-prediction in trained models
                p_h_ai, p_d_ai, p_a_ai = apply_draw_dampener(p_h_ai, p_d_ai, p_a_ai, league_name)
                analysis["DrawDampener"] = (
                    f"Draw dampened to empirical base rate for league ({_get_league_draw_base_rate(league_name):.3f})"
                )
            else:
                print("⚠️ [PREDICTION] XGBoost/Monte-Carlo indisponible, Poisson uniquement")
                ai_source = "Poisson-only (MC failed)"

        # Neural Meta-Refiner (1e application Python, désactivable — voir meta_refiner_python_enabled)
        if meta_refiner_python_enabled():
            p_h_refined, h_factor = refine_prediction(league_name, "Home", p_h_ai)
            p_a_refined, a_factor = refine_prediction(league_name, "Away", p_a_ai)
            p_d_refined, d_factor = refine_prediction(league_name, "Draw", p_d_ai)

            if abs(h_factor - 1.0) > 0.02 or abs(a_factor - 1.0) > 0.02:
                p_h_ai, p_d_ai, p_a_ai = p_h_refined, p_d_refined, p_a_refined
                s_ref = p_h_ai + p_d_ai + p_a_ai
                p_h_ai, p_d_ai, p_a_ai = p_h_ai/s_ref, p_d_ai/s_ref, p_a_ai/s_ref
                analysis["Meta-Refiner"] = f"الرقابة الذكية: تم تعديل الاحتمالات بناءً على الأداء التاريخي للدوري ({h_factor:.2f}x H, {a_factor:.2f}x A)."

        has_xgb = True
    except Exception as e:
        import traceback
        sys.stderr.write(f"⚠️ [XGB-INF] Error: {traceback.format_exc()}\n")

    return {
        'p_h_xgb': p_h_xgb, 'p_d_xgb': p_d_xgb, 'p_a_xgb': p_a_xgb,
        'p_h_ai': p_h_ai, 'p_d_ai': p_d_ai, 'p_a_ai': p_a_ai,
        'has_xgb': has_xgb, 'ai_source': ai_source,
        'explainer_data': explainer_data, 'analysis': analysis
    }


def apply_v4_ensemble(p_h_ai, p_d_ai, p_a_ai, match_obj, has_xgb):
    """Blend V2+V4 ensemble (85% V4 stats-based + 15% V2 historical)."""
    analysis = {}
    xgb = get_xgb()
    v4_booster = get_titanium_v4_booster()
    hp = match_obj.get('home_possession', 0)
    ap = match_obj.get('away_possession', 0)
    stats = match_obj.get('stats')
    has_v4_stats = (hp and hp > 0) or (ap and ap > 0) or (stats and len(stats) > 0)

    if v4_booster and has_v4_stats and has_xgb:
        try:
            v4_feats = extract_v4_features(match_obj)
            v4_vec = np.array([[v4_feats.get(f, 0.0) for f in FEATURE_NAMES_V4]], dtype=float)
            v4_vec = np.nan_to_num(v4_vec, nan=0.0)
            v4_probs = v4_booster.predict(xgb.DMatrix(v4_vec))[0]
            p_h_v4, p_d_v4, p_a_v4 = float(v4_probs[2]), float(v4_probs[1]), float(v4_probs[0])

            v4_weight = 0.85
            p_h_ai = (p_h_v4 * v4_weight) + (p_h_ai * (1.0 - v4_weight))
            p_d_ai = (p_d_v4 * v4_weight) + (p_d_ai * (1.0 - v4_weight))
            p_a_ai = (p_a_v4 * v4_weight) + (p_a_ai * (1.0 - v4_weight))

            s_ens = p_h_ai + p_d_ai + p_a_ai
            if s_ens > 0:
                p_h_ai, p_d_ai, p_a_ai = p_h_ai/s_ens, p_d_ai/s_ens, p_a_ai/s_ens

            analysis["V4-Ensemble"] = f"V2+V4 blend: {v4_weight*100:.0f}% V4 (stats-based) + {(1-v4_weight)*100:.0f}% V2 (historical)"
        except Exception as _v4_err:
            sys.stderr.write(f"⚠️ [V4-Ensemble] {_v4_err}\n")

    return p_h_ai, p_d_ai, p_a_ai, "+V4-Ensemble" if "V4-Ensemble" in analysis else "", analysis


_EXTERNAL_XGB_CALIBRATION_KEY = 'external_xgb_weight'


def _get_external_xgb_weight(league_name):
    """Per-league external XGBoost blend weight from calibration_weights.json (default 0.20)."""
    try:
        cal = _load_calibration_weights().get(league_name)
        if cal and cal.get(_EXTERNAL_XGB_CALIBRATION_KEY) is not None:
            w = float(cal[_EXTERNAL_XGB_CALIBRATION_KEY])
            return max(0.0, min(0.50, w))
    except Exception:
        pass
    return 0.20


def apply_external_xgb_blend(p_h_ai, p_d_ai, p_a_ai, match_obj):
    """
    Blend external XGBoost (msoczi/football_predictions) as an extra ensemble member.
    Active only for the 5 supported European leagues. Weight from calibration_weights.json.
    """
    analysis = {}
    try:
        from external_xgb import predict_external

        league = match_obj.get('league', '') or match_obj.get('league_name', '')
        home = match_obj.get('homeTeam', '')
        away = match_obj.get('awayTeam', '')
        ext = predict_external(league, home, away)
        if not ext:
            return p_h_ai, p_d_ai, p_a_ai, '', analysis

        xh, xd, xa = ext['xgb']['home'], ext['xgb']['draw'], ext['xgb']['away']
        s_x = xh + xd + xa
        if s_x <= 0:
            return p_h_ai, p_d_ai, p_a_ai, '', analysis
        xh, xd, xa = xh / s_x, xd / s_x, xa / s_x

        w = _get_external_xgb_weight(str(league))
        p_h_ai = (p_h_ai * (1.0 - w)) + (xh * w)
        p_d_ai = (p_d_ai * (1.0 - w)) + (xd * w)
        p_a_ai = (p_a_ai * (1.0 - w)) + (xa * w)
        s = p_h_ai + p_d_ai + p_a_ai
        if s > 0:
            p_h_ai, p_d_ai, p_a_ai = p_h_ai / s, p_d_ai / s, p_a_ai / s

        analysis["ExternalXGB"] = (
            f"External ensemble (msoczi XGBoost) weight={w:.2f}: "
            f"H={xh:.3f} D={xd:.3f} A={xa:.3f} | tree={ext.get('tree_label')}"
        )
        try:
            match_obj['_external_xgb'] = {'home': xh, 'draw': xd, 'away': xa}
            match_obj['_external_xgb_weight'] = w
        except Exception:
            pass
        return p_h_ai, p_d_ai, p_a_ai, "+ExternalXGB", analysis
    except Exception as _ext_err:
        sys.stderr.write(f"⚠️ [ExternalXGB] {_ext_err}\n")
        return p_h_ai, p_d_ai, p_a_ai, '', analysis


def run_shap_explainability(active_feature_vector, active_feature_names, XGB_BOOSTER,
                            p_h_xgb, p_d_xgb, p_a_xgb):
    """Run SHAP-Lite explainability to get top 5 feature impacts."""
    try:
        xgb = get_xgb()
        dmat_explain = xgb.DMatrix(np.array([active_feature_vector]), feature_names=active_feature_names)
        preds = XGB_BOOSTER.predict(dmat_explain, pred_contribs=True)[0]

        winner_idx = 0 if p_h_xgb > p_a_xgb and p_h_xgb > p_d_xgb else (2 if p_a_xgb > p_h_xgb and p_a_xgb > p_d_xgb else 1)

        num_f = len(active_feature_names)
        if len(preds) == num_f + 1:
            class_contribs = preds
        else:
            class_contribs = preds[winner_idx * (num_f + 1) : (winner_idx + 1) * (num_f + 1)]

        feature_impacts = []
        for i in range(num_f):
            if i < len(class_contribs):
                val = class_contribs[i]
                if isinstance(val, (list, tuple, np.ndarray)):
                    val = val[winner_idx] if len(val) > winner_idx else val[0]
                feature_impacts.append({
                    "name": active_feature_names[i],
                    "impact": float(val)
                })

        feature_impacts.sort(key=lambda x: abs(x['impact']), reverse=True)
        return feature_impacts[:5]
    except Exception as e:
        sys.stderr.write(f"⚠️ [SHAP-Lite] {e}\n")
        return []


def predict_secondary_markets(features, feature_vector):
    """Predict corners and cards using dedicated XGBoost models."""
    expected_corners = round(float(features.get('home_corners', 4.5) + features.get('away_corners', 4.5)), 1)
    expected_cards = round(float(features.get('home_cards', 2.0) + features.get('away_cards', 2.0)), 1)

    try:
        CORNERS_MODEL = get_corners_model()
        if CORNERS_MODEL:
            xgb = get_xgb()
            dmat_c = xgb.DMatrix(np.array([feature_vector]), feature_names=FEATURE_NAMES)
            expected_corners = round(float(CORNERS_MODEL.predict(dmat_c)[0]), 1)

        CARDS_MODEL = get_cards_model()
        if CARDS_MODEL:
            xgb = get_xgb()
            dmat_ca = xgb.DMatrix(np.array([feature_vector]), feature_names=FEATURE_NAMES)
            expected_cards = round(float(CARDS_MODEL.predict(dmat_ca)[0]), 1)
    except Exception as e:
        sys.stderr.write(f"⚠️ [Secondary-INF] Error: {str(e)}\n")

    return expected_corners, expected_cards


def blend_final_probabilities(p_h_ai, p_d_ai, p_a_ai, p_h_poi, p_d_poi, p_a_poi, has_xgb):
    """
    Global blending: AI Modules + Poisson Base + Platt Calibration.
    Returns: (p_h, p_d, p_a, ai_fusion_weight, ai_source_label)
    """
    if has_xgb:
        ai_fusion_weight = 0.95
        ai_source_label = "Titanium-XGB-Core-V54"
    else:
        ai_fusion_weight = 0.0
        ai_source_label = "Poisson-Tactical-V11 (AI Offline)"

    p_h = (p_h_ai * ai_fusion_weight) + (p_h_poi * (1.0 - ai_fusion_weight))
    p_d = (p_d_ai * ai_fusion_weight) + (p_d_poi * (1.0 - ai_fusion_weight))
    p_a = (p_a_ai * ai_fusion_weight) + (p_a_poi * (1.0 - ai_fusion_weight))

    p_sum = p_h + p_d + p_a
    if p_sum > 0:
        p_h, p_d, p_a = p_h/p_sum, p_d/p_sum, p_a/p_sum
    else:
        p_h, p_d, p_a = 0.33, 0.33, 0.34

    # Calibration : carte isotonique (confiance→taux réel) quand l'historique
    # réglé est suffisant, sinon repli sur Platt scaling. Les deux sont
    # défensifs : toute erreur laisse les probabilités brutes inchangées.
    # NOTE: désactivé par défaut — la carte isotonique actuelle a été ajustée
    # sur des échantillons de l'ancien modèle biaisé et détruit la précision.
    # Réactiver via ENABLE_ISO_CALIBRATION=1 après un refit propre.
    if has_xgb and os.getenv('ENABLE_ISO_CALIBRATION', '0') == '1':
        try:
            from calibration_iso import isotonic_calibrate
            p_h, p_d, p_a = isotonic_calibrate(p_h, p_d, p_a)
        except Exception:
            try:
                from calibration import calibrate_probs
                p_h, p_d, p_a = calibrate_probs(p_h, p_d, p_a, model_version='v54')
            except Exception:
                pass

    return p_h, p_d, p_a, ai_fusion_weight, ai_source_label
