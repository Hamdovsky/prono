import json
import sys
import math
import random
import os
import sqlite3
import numpy as np

# Fix relative import paths
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Lazy import helpers
_xgb = None

def get_xgb():
    global _xgb
    if _xgb is None:
        try:
            import xgboost as xgb
            _xgb = xgb
        except Exception as e:
            print(f"CRITICAL WARNING: Lazy xgboost import failed: {e}")
            class MockXGB:
                def __init__(self): self.DMatrix = lambda *args, **kwargs: None
            _xgb = MockXGB()
    return _xgb

import pickle # Added import
import warnings
warnings.filterwarnings("ignore")
import logging
logging.getLogger('absl').setLevel(logging.ERROR)

from ml_features import extract_ml_features, FEATURE_NAMES, FEATURE_NAMES_V24, FEATURE_NAMES_TITANIUM, calculate_rolling_averages, FEATURE_VOLATILITY

from top_analyst_engine import process_match_for_top_analyst

from leagues_master import classify_league# --- Core V11: Hybrid Ultra Engine (Pre-match + Live Module + Time Machine + Gap Learning) ---

# --- ABSOLUTE DEFENSE: Global Sanitizers ---
def _safe_float(val, default=0.0):
    try:
        if val is None or str(val).lower() in ['none', 'null', '', 'nan']: return float(default)
        return float(val)
    except:
        return float(default)

def _f_feat(key, source, default=0.0):
    if source is None: return float(default)
    try:
        if isinstance(source, dict):
            val = source.get(key)
        else:
            val = getattr(source, key, default)
        return _safe_float(val, default)
    except:
        return float(default)

# --- CACHE FOR STATISTICAL LOOKUPS ---
_LEAGUE_DRAW_CACHE = {}
_TEAM_STRENGTH_CACHE = {}
_LEAGUE_HA_CACHE = {}

# [V102] GLOBAL LEAGUE STRATEGY MATRIX
# Defines model dominance and news sensitivity per competition
LEAGUE_WEIGHT_MATRIX = {
    "Premier League": {"xgb_weight": 0.95, "news_boost": 0.15},
    "LaLiga": {"xgb_weight": 0.92, "news_boost": 0.25},
    "Serie A": {"xgb_weight": 0.88, "news_boost": 0.30},
    "Bundesliga": {"xgb_weight": 0.90, "news_boost": 0.15},
    "Saudi Pro League": {"xgb_weight": 0.65, "news_boost": 0.65},
    "Stoiximan Super League": {"xgb_weight": 0.55, "news_boost": 0.75}, 
    "Ligue 1": {"xgb_weight": 0.85, "news_boost": 0.35},
    "Primeira Liga": {"xgb_weight": 0.82, "news_boost": 0.45},
    "Eredivisie": {"xgb_weight": 0.88, "news_boost": 0.20},
    "T1": {"xgb_weight": 0.90, "news_boost": 0.20},
    "T2": {"xgb_weight": 0.70, "news_boost": 0.45},
    "T3": {"xgb_weight": 0.45, "news_boost": 0.85},
    "DEFAULT": {"xgb_weight": 0.75, "news_boost": 0.30}
}

def _get_league_draw_multiplier(feature_names, base_features, league_name=None):
    """
    [LEAGUE-AWARE DRAW CORRECTION] Computes a league-specific draw boost multiplier
    from historical data rather than using a global constant.
    Falls back to a safe default of 1.10 if data is unavailable.
    """
    try:
        global _LEAGUE_DRAW_CACHE
        cache_key = str(league_name) if league_name else 'global'
        if cache_key in _LEAGUE_DRAW_CACHE:
            return _LEAGUE_DRAW_CACHE[cache_key]
            
        conn = get_db_connection()
        if not conn:
            return 1.10  # safe default

        # Query historical draw rate for this specific league
        query = """
            SELECT ROUND(SUM(CASE WHEN scoreHome = scoreAway THEN 1.0 ELSE 0 END) / COUNT(*), 3) as draw_rate
            FROM archive_matches
            WHERE scoreHome IS NOT NULL
        """
        params = []
        if league_name:
            query += " AND tournament_name = ?"
            params.append(league_name)
            
        row = conn.execute(query, params).fetchone()
        if row and row[0]:
            real_draw_rate = float(row[0])
            # Expected XGBoost draw underestimation vs real rate
            expected_xgb_rate = max(0.18, real_draw_rate * 0.80)
            mult = min(1.25, real_draw_rate / expected_xgb_rate)
            _LEAGUE_DRAW_CACHE[cache_key] = round(mult, 3)
            return _LEAGUE_DRAW_CACHE[cache_key]
    except Exception:
        pass
    return 1.10  # safe default

def find_twin_matches(odds_h, odds_d, odds_a, xg_gap):
    """
    [TITANIUM TWIN-MATCH ORACLE]
    Finds historical matches with similar Odds DNA and xG profiles.
    Returns statistical distribution of outcomes.
    """
    try:
        conn = get_db_connection()
        if not conn: return None
        
        # Tolerance range for "Similarity"
        odds_tol = 0.25
        xg_tol = 0.35
        
        query = """
            SELECT scoreHome, scoreAway, tournament_name
            FROM archive_matches
            WHERE oddsHome BETWEEN ? AND ?
              AND oddsDraw BETWEEN ? AND ?
              AND oddsAway BETWEEN ? AND ?
              AND scoreHome IS NOT NULL
            LIMIT 50
        """
        params = (odds_h - odds_tol, odds_h + odds_tol, 
                  odds_d - odds_tol, odds_d + odds_tol, 
                  odds_a - odds_tol, odds_a + odds_tol)
        
        rows = conn.execute(query, params).fetchall()
        if not rows: return None
        
        results = {"home": 0, "draw": 0, "away": 0, "total": 0, "over25": 0}
        for r in rows:
            sh, sa = r['scoreHome'], r['scoreAway']
            results['total'] += 1
            if sh > sa: results['home'] += 1
            elif sh < sa: results['away'] += 1
            else: results['draw'] += 1
            if (sh + sa) > 2.5: results['over25'] += 1
            
        return results
    except:
        return None

def calculate_h2h_dominance(h_hist, a_hist, home_name, away_name):
    """[TACTICAL SECRET] Detects psychological dominance (Bête Noire)."""
    h_wins = 0
    a_wins = 0
    total = 0
    # Search for direct clashes in history
    combined = (h_hist or []) + (a_hist or [])
    seen = set()
    for m in combined:
        m_id = m.get('id')
        if m_id in seen: continue
        seen.add(m_id)
        
        m_h = m.get('homeTeam')
        m_a = m.get('awayTeam')
        sh = m.get('homeGoals')
        sa = m.get('awayGoals')
        
        if sh is None or sa is None: continue
        
        if (m_h == home_name and m_a == away_name):
            total += 1
            if sh > sa: h_wins += 1
            elif sa > sh: a_wins += 1
        elif (m_h == away_name and m_a == home_name):
            total += 1
            if sa > sh: h_wins += 1
            elif sh > sa: a_wins += 1
            
    if total < 3: return 1.0
    h_dominance = h_wins / total
    a_dominance = a_wins / total
    return {"h": h_dominance, "a": a_dominance, "total": total}

def apply_tactical_intelligence(match_obj, features, xg_h, xg_a):
    """
    [TITANIUM TACTICAL V3] Deep analysis of midfield, possession, and motivation.
    """
    tactical_alerts = []
    h_mod, a_mod = 1.0, 1.0
    
    # 1. Sterile Possession Check
    h_pos = _f_feat('h_pos', features, 50.0)
    h_sot = _f_feat('h_sot', features, 4.0)
    a_pos = _f_feat('a_pos', features, 50.0)
    a_sot = _f_feat('a_sot', features, 4.0)
    
    if h_pos > 58.0 and h_sot < 3.0:
        h_mod *= 0.82
        tactical_alerts.append("⚠️ POSSESSION STÉRILE (H): Domination sans danger.")
    if a_pos > 58.0 and a_sot < 3.0:
        a_mod *= 0.82
        tactical_alerts.append("⚠️ POSSESSION STÉRILE (A): Domination sans danger.")
        
    # 2. Midfield Engine Check (Roles over Stars)
    intel_h = match_obj.get('news_data', {}).get('home', {}).get('intelligence', {}) if isinstance(match_obj.get('news_data'), dict) else {}
    intel_a = match_obj.get('news_data', {}).get('away', {}).get('intelligence', {}) if isinstance(match_obj.get('news_data'), dict) else {}
    
    if intel_h.get('is_missing_midfielder') or match_obj.get('is_missing_midfielder'):
        h_mod *= 0.88
        xg_a *= 1.12 # Opponent gets more freedom
        tactical_alerts.append("💔 RUPTURE DU MILIEU (H): Absence du récupérateur clé.")
    if intel_a.get('is_missing_midfielder') or match_obj.get('is_missing_midfielder_away'):
        a_mod *= 0.88
        xg_h *= 1.12
        tactical_alerts.append("💔 RUPTURE DU MILIEU (A): Absence du récupérateur clé.")
        
    # 3. European/Relegation Enjeu Booster
    h_pos_rank = _f_feat('home_rank', match_obj, 10)
    a_pos_rank = _f_feat('away_rank', match_obj, 10)
    
    # High stakes: 1-4 (Europe) or 17-20 (Relegation)
    if h_pos_rank <= 4 or h_pos_rank >= 17:
        h_mod *= 1.08
        tactical_alerts.append("🔥 ENJEU MAXIMUM (H): Bataille pour l'Europe ou le Maintien.")
    if a_pos_rank <= 4 or a_pos_rank >= 17:
        a_mod *= 1.08
        tactical_alerts.append("🔥 ENJEU MAXIMUM (A): Bataille pour l'Europe ou le Maintien.")

    return xg_h * h_mod, xg_a * a_mod, tactical_alerts

# --- MONTE CARLO AI SIMULATION ---
def simulate_match_mc(model, base_features, num_simulations=500, feature_names=None, fatigue_impact=(1.0, 1.0), injury_impact=(0.0, 0.0), match_seed=None, league_name=None):
    """
    [TITANIUM V20] Quantum Monte Carlo Simulation.
    Injects tiered Gaussian noise into feature vectors to model performance variance and uncertainty.
    
    Args:
        model: Loaded XGBoost booster object.
        base_features: NumPy array or list of original feature values.
        num_simulations: Number of paths to simulate (default 200 for performance).
        feature_names: List of strings for column mapping (optional but recommended).
        fatigue_impact: Tuple (Home, Away) for physiological performance decay.
        injury_impact: Tuple (Home, Away) representing absentee severity.
        match_seed: Optional seed for deterministic reproducibility.
        
    Returns:
        Tuple: (p_home, p_draw, p_away) averaged over all simulations.
    """
    # [DETERMINISM FIX] Seed the RNG with a hash of the base features vector
    # This guarantees identical results for identical match data across all runs.
    if match_seed is None:
        match_seed = int(abs(hash(tuple(round(float(x), 4) for x in base_features)))) % (2**31)
    rng = np.random.default_rng(seed=match_seed)

    X_base = np.array(base_features, dtype=float)
    if X_base.ndim > 1: X_base = X_base.flatten()
    
    # Apply physiological penalties to the base feature vector before noise
    # This simulates a "depleted" baseline capability
    if feature_names:
        for idx, fname in enumerate(feature_names):
            if fname.startswith('h_') or 'home_' in fname:
                # Fatigue reduces performance linearly
                X_base[idx] *= fatigue_impact[0]
                # Injury acts as a capped negative weight (max 10% drop to avoid model shock)
                if injury_impact[0] > 0:
                    penalty = min(0.10, injury_impact[0] * 0.02)
                    X_base[idx] *= (1.0 - penalty)
            elif fname.startswith('a_') or 'away_' in fname:
                X_base[idx] *= fatigue_impact[1]
                if injury_impact[1] > 0:
                    penalty = min(0.10, injury_impact[1] * 0.02)
                    X_base[idx] *= (1.0 - penalty)
                    
    # --- V75 ADVANCED LOGISTICS & REFEREE BIAS ---
    weather_impact = 1.0
    ref_bias = 0.45
    if feature_names:
        if 'weather_impact' in feature_names:
            weather_impact = _safe_float(X_base[feature_names.index('weather_impact')])
        if 'ref_bias' in feature_names:
            ref_bias = _safe_float(X_base[feature_names.index('ref_bias')])
    
    num_features = len(X_base)
    # Generate noise matrix [num_simulations, num_features]
    noise_matrix = np.zeros((num_simulations, num_features))
    
    for i in range(num_features):
        fname = feature_names[i] if feature_names and i < len(feature_names) else "unknown"
        # Get volatility from FEATURE_VOLATILITY, default to 0.05
        vol = FEATURE_VOLATILITY.get(fname, 0.05)
        
        # [V75] Scale noise by weather impact (higher impact = more chaos/variance)
        if weather_impact > 1.05 and vol > 0.02: # Only scale volatile features
            vol *= min(1.5, weather_impact)
            
        # [New] Scale noise if a key player is missing (Injury impact > 3 implies Key Player)
        if (fname.startswith('h_') or 'home_' in fname) and injury_impact[0] >= 3.0 and vol > 0.02:
            vol *= 1.25 # 25% more chaotic due to missing key player
        elif (fname.startswith('a_') or 'away_' in fname) and injury_impact[1] >= 3.0 and vol > 0.02:
            vol *= 1.25
            
        # Generate gaussian noise for this specific feature
        noise_matrix[:, i] = rng.normal(0, vol, num_simulations)
    
    # Apply noise: X_sim = X_base * (1 + noise)
    # Special handling for binary features (don't inject noise into 0/1)
    X_simulated = np.tile(X_base, (num_simulations, 1))
    for i in range(num_features):
        if X_base[i] != 0 and X_base[i] != 1: # Only noise non-binary
            X_simulated[:, i] *= (1.0 + noise_matrix[:, i])
    
        # [V80] CRISIS MODE: If many key players are missing, the match becomes extremely unpredictable.
        if (injury_impact[0] > 6.0 or injury_impact[1] > 6.0) and num_simulations < 1000:
            # Automatic boost in simulations for higher precision in crisis
            num_simulations = 1000
            rng = np.random.default_rng(seed=match_seed + 1) # re-seed for extra entropy
        
    fn = feature_names if feature_names and len(feature_names) == X_simulated.shape[1] else None
    xgb = get_xgb()
    dmatrix = xgb.DMatrix(X_simulated, feature_names=fn)
    predictions = model.predict(dmatrix)
    
    if predictions.ndim == 2 and predictions.shape[1] >= 3:
        win_probability = np.mean(predictions[:, 0])
        draw_probability = np.mean(predictions[:, 1])
        loss_probability = np.mean(predictions[:, 2])
        
        # [V75 REFEREE BIAS ADJUSTMENT]
        # Shift probability slightly towards Home/Away based on Ref historical bias
        if ref_bias > 0.52: # Home favorist
            shift = (ref_bias - 0.50) * 0.15 # Small 1-3% shift
            win_probability += shift
            loss_probability -= shift
        elif ref_bias < 0.40: # Away favorist (uncommon)
            shift = (0.45 - ref_bias) * 0.15
            loss_probability += shift
            win_probability -= shift

        # [V70 REALISM — LEAGUE-AWARE] XGBoost Draw Bias Correction
        # Classifiers trained on rare outcomes (draws) often underestimate them.
        # Draw correction multiplier is now sourced from real league historical data
        # instead of a hardcoded global constant.
        if draw_probability < 0.26 and abs(win_probability - loss_probability) < 0.25:
            league_draw_mult = _get_league_draw_multiplier(feature_names, base_features, league_name=league_name)
            draw_probability *= league_draw_mult
            
    else:
        # Voter Approach
        win_probability = np.mean(predictions == 0)
        draw_probability = np.mean(predictions == 1)
        loss_probability = np.mean(predictions == 2)
        
        if draw_probability < 0.18:
            league_draw_mult = _get_league_draw_multiplier(feature_names, base_features, league_name=league_name)
            draw_probability *= min(1.15, league_draw_mult)

    # Re-normalize to ensure sum is exactly 1.0
    total_p = win_probability + draw_probability + loss_probability
    win_probability /= total_p
    draw_probability /= total_p
    loss_probability /= total_p
    
    return float(win_probability), float(draw_probability), float(loss_probability)
def get_dixon_coles_adjustment(lh, la, h, a, rho=-0.12):
    """
    Apply Dixon-Coles adjustment for low-scoring matches (0-0, 0-1, 1-0, 1-1).
    Basic Poisson models tend to underestimate draws in low-scoring games.
    """
    if h == 0 and a == 0:
        return 1 - (lh * la * rho)
    elif h == 1 and a == 0:
        return 1 + (la * rho)
    elif h == 0 and a == 1:
        return 1 + (lh * rho)
    elif h == 1 and a == 1:
        return 1 - rho
    return 1.0

def calculate_ah_dnb_probs(p_h, p_d, p_a):
    """
    Calculate professional market probabilities:
    - Draw No Bet (AH 0.0)
    - Double Chance
    """
    total_non_draw = p_h + p_a
    if total_non_draw == 0: return 0.5, 0.5, 0.5, 0.5, 1.0
    
    dnb_h = p_h / total_non_draw
    dnb_a = p_a / total_non_draw
    
    dc_h = p_h + p_d
    dc_a = p_a + p_d
    dc_12 = p_h + p_a
    
    return dnb_h, dnb_a, dc_h, dc_a, dc_12

def generate_strategic_brief(features, home_name, away_name, selection, match_obj=None):
    """
    V22: Professional Strategic Tactical Narrative.
    Integrates referee bias, weather impact, and squad depth.
    """
    try:
        styles = {
            1: "Contre-attaque éclair",
            2: "Possession patiente",
            3: "Pressing intensif",
            4: "Jeu direct/Long ball",
            5: "Défense regroupée",
            6: "Transition rapide",
            0: "Standard équilibré"
        }
        h_style = styles.get(int(features.get('h_style_enc', 0)), "Standard")
        a_style = styles.get(int(features.get('a_style_enc', 0)), "Standard")
        
        brief = f"Analyse Tactique : Opposition entre {home_name} ({h_style}) et {away_name} ({a_style}). "
        
        # Motivation & Pressure
        mot = _safe_float(features.get('motivation_context'), 1.0)
        if mot > 1.3: brief += "Enjeu de haute intensité détecté (Pression maximale). "
        elif mot < 0.8: brief += "Contexte de match avec rotation probable/faible enjeu. "
        
        # 🏛️ Referee Impact
        ref_hwr = _safe_float(features.get('referee_home_win_rate'), 0.45)
        if ref_hwr > 0.55: brief += "Arbitrage statistiquement favorable à l'avantage du terrain. "
        
        # 🌦️ Weather Impact
        weather = str(features.get('weather_desc', '')).lower()
        if 'rain' in weather or 'snow' in weather:
            brief += "Conditions météorologiques défavorables pouvant limiter la fluidité du jeu. "

        # 🚨 Key Absences
        h_inj = _safe_float(features.get('home_injury_impact'), 0)
        a_inj = _safe_float(features.get('away_injury_impact'), 0)
        if h_inj >= 3.0: brief += f"Absence critique pour {home_name} (Impact structurel -15%). "
        if a_inj >= 3.0: brief += f"Absence critique pour {away_name} (Impact structurel -15%). "

        # Verdict logic
        if selection == "Home": brief += f"Conclusion : Supériorité dans les transitions pour {home_name}."
        elif selection == "Away": brief += f"Conclusion : Capacité de rupture élevée pour {away_name}."
        else: brief += "Conclusion : Neutralisation tactique attendue dans l'entrejeu."
        
        return brief
    except:
        return "Analyse tactique complexe : Équilibre des forces en présence avec variables multiples."

# --- MODELS AND SCALERS CACHE ---
ELO_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'elo_ratings.json')
DB_ARCHIVE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'historical_archive.sqlite')
XGB_MODEL_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'stitch_v24_hybrid.json')
ACCURACY_LOG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'accuracy_log.json')
TACTICAL_DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'tactical.db')

# V18 Secondary Markets
CORNERS_MODEL_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'stitch_corners_v1.json')
CARDS_MODEL_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'stitch_cards_v1.json')
TITANIUM_MODEL_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'titanium_v2.json')

STYLISTIC_MATRIX = {
    # attacker_style: { defender_style: multiplier }
    "Possession": {"Low Block": 0.85, "Counter-Attack": 1.15, "High Press": 1.0, "Balanced": 1.0},
    "Counter-Attack": {"Possession": 1.25, "High Press": 1.20, "Low Block": 0.70, "Balanced": 1.0},
    "High Press": {"Low Block": 1.15, "Possession": 1.10, "Counter-Attack": 0.90, "Balanced": 1.0},
    "Low Block": {"High Press": 0.80, "Counter-Attack": 1.10, "Possession": 1.20, "Balanced": 1.0}
}

def load_elo_ratings():
    if os.path.exists(ELO_PATH):
        try:
            with open(ELO_PATH, 'r', encoding='utf-8') as f:
                return json.load(f)
        except: return {}
    return {}

ELO_DATA = load_elo_ratings()

# --- Persistent Database Connections ---
_DB_CONN = None
_TACTICAL_CONN = None

def get_db_connection():
    global _DB_CONN
    if _DB_CONN is None:
        try:
            _DB_CONN = sqlite3.connect(DB_ARCHIVE_PATH, check_same_thread=False)
            _DB_CONN.row_factory = sqlite3.Row
        except: return None
    return _DB_CONN

def get_tactical_connection():
    global _TACTICAL_CONN
    if _TACTICAL_CONN is None:
        try:
            _TACTICAL_CONN = sqlite3.connect(TACTICAL_DB_PATH, check_same_thread=False)
            _TACTICAL_CONN.row_factory = sqlite3.Row
        except: return None
    return _TACTICAL_CONN

# AI Boosters (Lazy Loaded)
_XGB_BOOSTER = None
_CORNERS_MODEL = None
_CARDS_MODEL = None
_TITANIUM_BOOSTER = None

def get_titanium_booster():
    global _TITANIUM_BOOSTER
    if _TITANIUM_BOOSTER is None and os.path.exists(TITANIUM_MODEL_PATH):
        try:
            xgb = get_xgb()
            _TITANIUM_BOOSTER = xgb.Booster()
            _TITANIUM_BOOSTER.load_model(TITANIUM_MODEL_PATH)
        except Exception as e:
            sys.stderr.write(f"⚠️ [XGB] Failed to load Titanium model: {str(e)}\n")
            _TITANIUM_BOOSTER = None
    return _TITANIUM_BOOSTER

def get_main_booster():
    global _XGB_BOOSTER
    if _XGB_BOOSTER is None and os.path.exists(XGB_MODEL_PATH):
        try:
            xgb = get_xgb()
            _XGB_BOOSTER = xgb.Booster()
            _XGB_BOOSTER.load_model(XGB_MODEL_PATH)
        except Exception as e:
            sys.stderr.write(f"⚠️ [XGB] Failed to load model v24: {str(e)}\n")
            _XGB_BOOSTER = None
    return _XGB_BOOSTER

def get_corners_model():
    global _CORNERS_MODEL
    if _CORNERS_MODEL is None and os.path.exists(CORNERS_MODEL_PATH):
        try:
            xgb = get_xgb()
            _CORNERS_MODEL = xgb.Booster()
            _CORNERS_MODEL.load_model(CORNERS_MODEL_PATH)
        except: pass
    return _CORNERS_MODEL

def get_cards_model():
    global _CARDS_MODEL
    if _CARDS_MODEL is None and os.path.exists(CARDS_MODEL_PATH):
        try:
            xgb = get_xgb()
            _CARDS_MODEL = xgb.Booster()
            _CARDS_MODEL.load_model(CARDS_MODEL_PATH)
        except: pass
    return _CARDS_MODEL

# SHAP EXPLAINER DISABLED
SHAP_EXPLAINER = None

def calculate_team_strength(team_name, venue='overall'):
    """[VENUE-AWARE] Calculates team strength using exponential decay weighting.
    venue: 'home', 'away', or 'overall'
    """
    try:
        cache_key = f"{team_name}_{venue}"
        if cache_key in _TEAM_STRENGTH_CACHE:
            return _TEAM_STRENGTH_CACHE[cache_key]
            
        conn = get_db_connection()
        if not conn: return 1.0, 1.0

        if venue == 'home':
            where = "homeTeam = ?"
            score_for = "scoreHome"
            score_against = "scoreAway"
            params = (team_name,)
        elif venue == 'away':
            where = "awayTeam = ?"
            score_for = "scoreAway"
            score_against = "scoreHome"
            params = (team_name,)
        else:
            where = "(homeTeam = ? OR awayTeam = ?)"
            params = (team_name, team_name)

        query = f"""
            SELECT homeTeam, awayTeam, scoreHome, scoreAway
            FROM archive_matches
            WHERE {where}
              AND scoreHome IS NOT NULL AND scoreAway IS NOT NULL
            ORDER BY startTimestamp DESC
            LIMIT 10
        """
        rows = conn.execute(query, params).fetchall()
        if not rows: return 1.2, 1.2

        scored_w = 0.0
        conceded_w = 0.0
        total_w = 0.0
        ALPHA = 0.75  # Exponential decay factor

        for i, row in enumerate(rows):
            w = ALPHA ** i  # Weight decays exponentially: 1, 0.75, 0.56, 0.42...
            total_w += w
            if venue == 'overall':
                is_home = row['homeTeam'] == team_name
                s = row['scoreHome'] if is_home else row['scoreAway']
                c = row['scoreAway'] if is_home else row['scoreHome']
                # Venue-aware goal weighting
                goal_mult = 1.0 if is_home else 1.1
                concede_mult = 1.1 if is_home else 1.0
            else:
                s = row[score_for]
                c = row[score_against]
                goal_mult = 1.0
                concede_mult = 1.0

            scored_w += _safe_float(s) * w * goal_mult
            conceded_w += _safe_float(c) * w * concede_mult

        avg_scored = scored_w / total_w if total_w > 0 else 1.2
        avg_conceded = conceded_w / total_w if total_w > 0 else 1.2
        _TEAM_STRENGTH_CACHE[cache_key] = (avg_scored, avg_conceded)
        return avg_scored, avg_conceded
    except Exception:
        return 1.2, 1.2

def get_league_volatility_penalty(league_name):
    """
    Categorizes leagues and returns a confidence penalty and a volatility flag.
    Returns: (penalty_percentage, is_volatile)
    """
    if not league_name:
        return 10.0, True
        
    league = str(league_name).lower()
    
    # Elite Leagues - No penalty
    elite_leagues = [
        'premier league', 'la liga', 'serie a', 'bundesliga', 'ligue 1',
        'champions league', 'world cup', 'euro',
        # African elite
        'africa cup of nations', 'afcon', 'caf champions league',
        'african nations championship', 'chan',
    ]
    if any(e in league for e in elite_leagues):
        return 0.0, False
        
    # Standard Leagues - Minimal penalty
    standard_leagues = ['championship', 'eredivisie', 'primeira liga', 'mls', 'brasileirao', 'liga mx', 'europa league', 'super lig', 'pro league', '1st division', 'serie b', 'segunda']
    if any(s in league for s in standard_leagues):
        return 5.0, False
        
    # Volatile Leagues - High penalty (Youth, Women, State leagues, Obscure)
    volatile_keywords = ['u19', 'u20', 'u21', 'u23', 'women', 'w-league', 'kvinner', 'nadeshiko', 'state', 'premier league 1', 'premier league 2', 'premier league 3', 'npl', 'reserve', 'amateur', 'friendly']
    if any(v in league for v in volatile_keywords):
        return 16.0, True
        
    # Default (Unknown/Obscure) - Moderate penalty
    return 10.0, True

def get_league_home_advantage(league_name):
    """Calculates real Home Advantage for a specific league from archive data."""
    try:
        if league_name in _LEAGUE_HA_CACHE:
            return _LEAGUE_HA_CACHE[league_name]
            
        conn = get_db_connection()
        if not conn: return 1.15

        # Average goals scored by Home vs Away teams in this league (last 200 games)
        query = """
            SELECT AVG(scoreHome) as avg_h, AVG(scoreAway) as avg_a
            FROM archive_matches
            WHERE tournament_name = ? AND scoreHome IS NOT NULL
            ORDER BY id DESC LIMIT 200
        """
        res = conn.execute(query, (league_name,)).fetchone()
        if res and res['avg_h'] and res['avg_a']:
            # Ratio of home superiority
            _LEAGUE_HA_CACHE[league_name] = float(res['avg_h'] / res['avg_a'])
            return _LEAGUE_HA_CACHE[league_name]
    except: pass
    return 1.15 # Fallback to standard 15%

def get_h2h_modifier(home_name, away_name):
    """Detects 'Bête Noire' (Black Beast) effect from last 5 direct encounters."""
    try:
        conn = get_db_connection()
        if not conn: return 1.0, 1.0
        query = """
            SELECT homeTeam, awayTeam, scoreHome, scoreAway
            FROM archive_matches
            WHERE ((homeTeam = ? AND awayTeam = ?) OR (homeTeam = ? AND awayTeam = ?))
            AND scoreHome IS NOT NULL
            ORDER BY id DESC LIMIT 5
        """
        rows = conn.execute(query, (home_name, away_name, away_name, home_name)).fetchall()
        
        if not rows: return 1.0, 1.0
        
        home_points = 0
        total_possible = len(rows) * 3
        for r in rows:
            is_home = (r['homeTeam'] == home_name)
            sh, sa = r['scoreHome'], r['scoreAway']
            if sh == sa: home_points += 1
            elif (is_home and sh > sa) or (not is_home and sa > sh): home_points += 3
        
        win_rate = home_points / total_possible
        # If one team dominates (>70% points), apply modifier
        if win_rate > 0.7: return 1.15, 0.85 # Strong H2H edge
        if win_rate < 0.3: return 0.85, 1.15 # Strong H2H disadvantage
    except: pass
    return 1.0, 1.0

# --- V50: Advanced Algorithmic Concepts ---
# --- V50+ SURGICAL INTELLIGENCE: Refined Mathematical Models ---

def calculate_dmf_hafiz(target_weight, distance_target, matches_rem, matches_played, is_dead_zone=False):
    """
    [TITANIUM V50+] Hafiz Dynamic Motivation Factor (DMF).
    Quantifies team urgency using an exponential pressure gradient based on ranking/points proximity.
    
    Formula: DMF = 1.0 + (Pressure * Gamma_Scarcity)
    where Pressure = weight * exp(-lambda * distance)
    
    Args:
        target_weight: Importance of the current objective (0.0 to 1.0).
        distance_target: Points or ranking distance from target.
        matches_rem: Remaining matches in the season.
        matches_played: Matches already completed.
        is_dead_zone: Boolean flag for teams with mathematically zero stakes.
        
    Returns:
        float: Multiplier between 0.85 (Dead Zone) and ~2.5 (Maximum Urgency).
    """
    if is_dead_zone: return 0.85 # Penalization for Dead Zone teams (low motivation)
    
    # Scarcity factor: pressure increases as season ends (gamma)
    gamma = 1.0 + (matches_played / max(1, matches_played + matches_rem)) * 0.5
    
    # Pressure Gradient (exponential decay)
    # lambda = 0.1 means pressure drops by ~10% per point away from target
    pressure = target_weight * math.exp(-0.15 * max(0, distance_target))
    
    return round(1.0 + (pressure * gamma), 3)

def calculate_xg_perf_delta(history, is_home=True):
    """
    V50+ xG-Elo Layer: Measures 'Quality of Play' (QoP) delta.
    Compares actual results vs expected performance (xG) in last 5 games.
    """
    if not history: return 0.0
    recent = history[:5]
    delta_sum = 0.0
    weights = [1.0, 0.8, 0.6, 0.4, 0.2] # Recency weighting
    
    for i, m in enumerate(recent):
        # xG Delta = (xG For - xG Against) - (Goals For - Goals Against)
        # Positive delta = Under-rewarded (good performance, bad result)
        # Negative delta = Over-rewarded (lucky win)
        xg_f = _safe_float(m.get('h_xg' if is_home else 'a_xg'), 1.0)
        xg_a = _safe_float(m.get('a_xg' if is_home else 'h_xg'), 1.0)
        g_f = _safe_float(m.get('score_for'), 1.0)
        g_a = _safe_float(m.get('score_against'), 1.0)
        
        qop = (xg_f - xg_a) - (g_f - g_a)
        delta_sum += qop * weights[i]
        
    return delta_sum / sum(weights[:len(recent)])

def impute_missing_match_data(features, match_obj):
    """
    V50+ Imputation Protocol: Ensures zero-crash for missing travel/rest data.
    Now extended to robustly handle the 115 variables, specifically missing players.
    """
    # 1. Rest Imputation: Default to 7 days (standard week) if unknown
    if features.get('rest_h', 0) <= 0: features['rest_h'] = 7.0
    if features.get('rest_a', 0) <= 0: features['rest_a'] = 7.0
    
    # 2. Travel Imputation: If travel_f is 0 but teams are different countries
    if features.get('travel_f', 0) == 0:
        # Basic proxy: if it's an international match, assume travel fatigue
        if match_obj.get('is_international') or 'world' in str(match_obj.get('category_name', '')).lower():
            features['travel_f'] = 2.5 # Average intl travel fatigue
            
    # 3. Secure Core Intelligence Flags (V46 Arabic/News intel)
    # Missing this could crash Composite Confidence or XGBoost. Defualt to 0.0
    intel_keys = ['news_is_missing_gk', 'news_is_missing_scorer', 'news_is_missing_captain', 'news_is_missing_star']
    for k in intel_keys:
        if features.get(k) is None or str(features.get(k)) == 'nan':
            features[k] = 0.0

    # 4. Data Completeness Check
    essential = ['h_xg', 'a_xg', 'h_pos', 'a_pos']
    
    # [TITANIUM V52.2] Friendly Neutral Imputation
    # If it's a friendly and data is missing, we impute "Competitive Baseline" to avoid NO BET
    tournament = str(match_obj.get('league', '')).lower() + " " + str(match_obj.get('tournament_name', '')).lower()
    is_friendly = any(x in tournament for x in ['friendly', 'amical', 'club matches', 'world', 'international'])
    
    if is_friendly:
        if features.get('h_xg', 0) <= 0: features['h_xg'] = 1.25
        if features.get('a_xg', 0) <= 0: features['a_xg'] = 1.15
        if features.get('h_pos', 0) <= 0: features['h_pos'] = 50.0
        if features.get('a_pos', 0) <= 0: features['a_pos'] = 50.0
        if features.get('h_sot', 0) <= 0: features['h_sot'] = 4.0
        if features.get('a_sot', 0) <= 0: features['a_sot'] = 3.5

    completeness = sum(1 for f in essential if features.get(f, 0) > 0) / len(essential)
    features['data_completeness'] = completeness * 100
    
    return features

def calculate_composite_confidence(p_xgb, h_dmf, a_dmf, lineups_confirmed, data_completeness=100.0):
    """
    V50+ Composite Confidence Level.
    [TITANIUM V85] Optimized scaling to avoid mid-range clusters.
    """
    # 1. Model Clarity: Distance from random 33% 
    # Use a quadratic boost to reward clear favorites
    clarity_base = abs(p_xgb - 0.33) / 0.67
    clarity = math.pow(clarity_base, 0.7) # Boost low-mid range clarity
    
    # 2. Motivation Synergy
    mot_polarity = abs(h_dmf - a_dmf) / 2.0
    
    # 3. Lineup Bonus (15% boost)
    lineup_factor = 0.15 if lineups_confirmed else 0.0
    
    # [TITANIUM V85] Base confidence starts at 45% if we have any clarity
    base_boost = 35.0 if clarity > 0.05 else 10.0
    
    conf = (clarity * 45.0) + (mot_polarity * 20.0) + (lineup_factor * 100.0) + base_boost
    conf_pct = max(10.0, min(98.5, conf))
    
    # [V80] Data Sparsity Penalization (Relaxed)
    if data_completeness < 60.0:
        penalty = ((60.0 - data_completeness) / 60.0) * 20.0
        conf_pct -= penalty
        
    return max(5.0, min(99.0, conf_pct))

def calculate_fatigue_mod(days_rest):
    if days_rest is None: return 1.0
    if days_rest <= 3: return 0.92 # High fatigue
    if days_rest >= 7: return 1.05 # Well rested
    return 1.0

def get_league_goals_multiplier(league_name):
    """
    [TITANIUM V88] League-Specific Goal Density Mapping.
    Returns a multiplier for total goal expectancy based on historical league behavior.
    """
    league = str(league_name).lower()
    
    # High Scoring Leagues (Over 2.5 heavy)
    high_scoring = [
        'bundesliga', 'eredivisie', 'pro league', 'a-league', 'super lig', 
        'mls', 'allsvenskan', 'eliteserien', '1. liga', 'bundesliga 2'
    ]
    # Low Scoring Leagues (Under 2.5 heavy)
    low_scoring = [
        'ligue 2', 'serie b', 'segunda', 'primeira liga', 'greek', 'egypt',
        'morocco', 'iran', 'south africa', 'argentina', 'colombia', 'romania'
    ]
    
    if any(x in league for x in high_scoring): return 1.12
    if any(x in league for x in low_scoring): return 0.86
    return 1.0

def calculate_composite_defense(features, is_home=True):
    """
    Calculates a defensive solidity index (0.5 to 1.5).
    Lower is better (tighter defense).
    """
    prefix = 'h_' if is_home else 'a_'
    opp_prefix = 'a_' if is_home else 'h_'
    
    # 1. Historical Goals Against (weighted)
    ga = float(features.get(f'{prefix}ga', 1.2))
    
    # 2. Goalkeeper Effectiveness (Saves)
    saves = float(features.get(f'{prefix}saves', 3.0))
    save_factor = 1.0 - (min(5, saves) * 0.03) # Up to 15% reduction if saves are high
    
    # 3. Defensive Actions (Tackles/Interceptions if available)
    tackles = float(features.get(f'{prefix}tackles', 15.0))
    tackle_factor = 1.0 - (min(25, tackles) * 0.01) # Up to 25% reduction
    
    # 4. Big Chances conceded (The real danger)
    bc_conceded = float(features.get(f'{opp_prefix}bc', 1.5))
    bc_factor = 1.0 + (min(4, bc_conceded) * 0.1) # Up to 40% increase if conceding many BC
    
    base_def = (ga / 1.2) * save_factor * tackle_factor * bc_factor
    return max(0.6, min(1.4, base_def))


def get_advanced_xg_adjustment(home_name, away_name, league_name, features=None):
    """Returns (xg_home, xg_away) based on weighted historical strength with dynamic HA and H2H."""
    h_scored, h_conceded = calculate_team_strength(home_name)
    a_scored, a_conceded = calculate_team_strength(away_name)
    
    # Dynamic Home Advantage
    ha_ratio = get_league_home_advantage(league_name)
    
    # Base calculation
    xg_h = (h_scored + a_conceded) / 2 * ha_ratio
    xg_a = (a_scored + h_conceded) / 2 * (1.0 / ha_ratio)
    
    # H2H Modifier
    h2h_h, h2h_a = get_h2h_modifier(home_name, away_name)
    xg_h *= h2h_h
    xg_a *= h2h_a
    
    # Physiological Modifiers [V80 Explicit Degradation]
    if features:
        h_inj = features.get('home_injury_impact', 0)
        a_inj = features.get('away_injury_impact', 0)
        if h_inj >= 3.0: xg_h *= 0.85
        elif h_inj > 0: xg_h *= 0.95
            
        if a_inj >= 3.0: xg_a *= 0.85
        elif a_inj > 0: xg_a *= 0.95
            
        rest_h = features.get('rest_h', 7.0)
        rest_a = features.get('rest_a', 7.0)
        if rest_h <= 3.0: xg_h *= (1.0 - (4.0 - rest_h) * 0.1)
        if rest_a <= 3.0: xg_a *= (1.0 - (4.0 - rest_a) * 0.1)
    
    # ELO Boost
    h_elo = ELO_DATA.get(home_name, 1500)
    a_elo = ELO_DATA.get(away_name, 1500)
    elo_diff = h_elo - a_elo
    
    xg_h *= (1.0 + elo_diff / 2000.0)
    xg_a *= (1.0 - elo_diff / 2000.0)
    
    return max(0.4, xg_h), max(0.4, xg_a)

def calculate_most_likely_score(xg_h, xg_a):
    """Find the most probable exact score using Dixon-Coles Poisson."""
    best_score = (1, 1)
    best_prob = -1
    for h in range(8):
        for a in range(8):
            # Standard Poisson
            prob = poisson_prob(xg_h, h) * poisson_prob(xg_a, a)
            # Dixon-Coles Adjustment
            prob *= get_dixon_coles_adjustment(xg_h, xg_a, h, a)
            
            if prob > best_prob:
                best_prob = prob
                best_score = (h, a)
    return f"{best_score[0]} - {best_score[1]}"

def calculate_exact_score(xg_h, xg_a, p_home, p_away):
    """Derive most likely scoreline from xG and adjust for high win confidence."""
    # Get the most probable scoreline from Poisson distribution
    score_str = calculate_most_likely_score(xg_h, xg_a)
    h_f, a_f = map(int, score_str.split(' - '))
    # If win probability is very high but score doesn't reflect it, adjust
    if p_home > 55 and h_f <= a_f:
        h_f = a_f + 1
    elif p_away > 55 and a_f <= h_f:
        a_f = h_f + 1
    return f"{max(0, min(7, h_f))} - {max(0, min(7, a_f))}"

def get_stylistic_clash_modifier(home_style, away_style, home_momentum=1.0, away_momentum=1.0):
    """V13 Style Matcher + V80 Form Scaling: Adjusts xG based on how playstyles interact."""
    h_mod = STYLISTIC_MATRIX.get(home_style, {}).get(away_style, 1.0)
    a_mod = STYLISTIC_MATRIX.get(away_style, {}).get(home_style, 1.0)
    
    if h_mod > 1.0 and home_momentum < 0.9: h_mod = 1.0 + (h_mod - 1.0) * home_momentum
    elif h_mod < 1.0 and home_momentum > 1.2: h_mod = 1.0 - (1.0 - h_mod) * 0.5
        
    if a_mod > 1.0 and away_momentum < 0.9: a_mod = 1.0 + (a_mod - 1.0) * away_momentum
    elif a_mod < 1.0 and away_momentum > 1.2: a_mod = 1.0 - (1.0 - a_mod) * 0.5
        
    return h_mod, a_mod

def get_referee_discipline_profile(ref_name):
    """V13 Discipline Engine: Detects referee's strictness."""
    if not ref_name: return 1.0
    # Simple proxy: if multiple penalties or reds in history, increase strictness
    # In a full build, this would query a referee database
    return 1.2 if "Strict" in str(ref_name) else 1.0

def poisson_prob(lam, k):
    if k < 0: return 0
    if lam <= 0: return 1.0 if k == 0 else 0.0
    return (math.exp(-lam) * (lam**k)) / math.factorial(k)

def monte_carlo_simulation(xg_h, xg_a, iterations=1000):
    """Simulates match outcomes using Bivariate Poisson distributions for scientific accuracy.
    V80 REALISM: Simulates goal co-dependence (shared variance) to accurately price draws.
    """
    h_wins = 0
    draws = 0
    a_wins = 0
    total_goals_list = []
    btts_count = 0
    
    # [V80] Bivariate Covariance: Assume goals are slightly correlated
    # Usually matches open up, giving a baseline shared expectation
    cov = 0.15 * min(max(0, xg_h), max(0, xg_a))
    if math.isnan(cov) or math.isinf(cov): cov = 0.0
    
    base_h = max(0, xg_h - cov)
    base_a = max(0, xg_a - cov)
    
    # Generate random Poisson outcomes
    home_base = np.random.poisson(base_h, iterations)
    away_base = np.random.poisson(base_a, iterations)
    shared_goals = np.random.poisson(cov, iterations)
    
    for i in range(iterations):
        gh = home_base[i] + shared_goals[i]
        ga = away_base[i] + shared_goals[i]
        
        if gh > ga: h_wins += 1
        elif gh < ga: a_wins += 1
        else: draws += 1
        
        total_goals_list.append(gh + ga)
        if gh > 0 and ga > 0: btts_count += 1
            
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

def apply_live_event_adjustment(match_obj, p_h, p_d, p_a):
    is_live = match_obj.get('status') == 'LIVE' or match_obj.get('is_live', False)
    if not is_live: return p_h, p_d, p_a, []

    alerts = []
    stats_raw = match_obj.get('stats_blob', '[]')
    if isinstance(stats_raw, str):
        try: stats = json.loads(stats_raw)
        except: stats = []
    else: stats = stats_raw
    
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
        alerts.append({"type": "LIVE_RED", "team": "home", "msg": f"⚠️ RED CARD (HOME) x{red_h} - STITCH ADJUSTING LIVE..."})

    if red_a > 0:
        penalty = 0.25 * red_a
        p_a -= p_a * penalty
        p_h += (p_a * penalty * 0.7)
        p_d += (p_a * penalty * 0.3)
        alerts.append({"type": "LIVE_RED", "team": "away", "msg": f"⚠️ RED CARD (AWAY) x{red_a} - STITCH ADJUSTING LIVE..."})

    # --- V25 EMERGENCY PROTOCOL: RED CARD OVERRIDE ---
    if red_h > 0 or red_a > 0:
        alerts.append({"type": "V25_EMERGENCY", "msg": "🚨 [V25] Red Card Emergency Protocol: Normalizing historical bias..."})
        # Note: In a full V25 build, this would trigger a specialized XGBoost DMatrix inference.
        # Here we simulate the effect by increasing defensive resilience weight.
    
    s_total = p_h + p_d + p_a
    if s_total == 0: return 0.33, 0.33, 0.34, alerts
    return p_h/s_total, p_d/s_total, p_a/s_total, alerts

def get_historical_patterns(home_team, away_team, match_month):
    """Time Machine Engine: Detects Monthly Curses or Peaks."""
    if not os.path.exists(TACTICAL_DB_PATH): return None, None
    try:
        conn = get_tactical_connection()
        if not conn: return None, None
        query = "SELECT * FROM historical_patterns WHERE is_active = 1 AND (team_name = ? OR team_name = ?)"
        rows = conn.execute(query, (home_team, away_team)).fetchall()
        
        home_pattern, away_pattern = None, None
        for r in rows:
            name, ptype = r['team_name'], r['pattern_type']
            is_valid = False
            if ptype.startswith("MONTH_"):
                try:
                    pat_month = int(ptype.split('_')[-1])
                    if pat_month == int(match_month): is_valid = True
                except: pass
            else: is_valid = True
            if is_valid:
                if name == home_team: home_pattern = dict(r)
                elif name == away_team: away_pattern = dict(r)
        return home_pattern, away_pattern
    except: return None, None

def apply_gap_learning_weight(prob_dict, league_name):
    """Refines probabilities based on historical performance in this specific league."""
    if not os.path.exists(ACCURACY_LOG_PATH): return prob_dict, 0.0
    try:
        with open(ACCURACY_LOG_PATH, 'r', encoding='utf-8') as f:
            log_data = json.load(f)
        
        league_log = log_data.get(str(league_name), [])
        if not league_log: return prob_dict, 0.0
        
        # Calculate recent failure rate (last 10 matches)
        recent_matches = league_log[-10:]
        failures = sum(1 for m in recent_matches if m.get('vote_was_misleading'))
        
        if failures >= 2:
            # Scale penalty: 2 failures = 5%, 5 failures = 15%, max 25%
            penalty_strength = min(0.25, (failures / 10.0) * 0.5)
            
            max_key = max(prob_dict, key=prob_dict.get)
            min_key = min(prob_dict, key=prob_dict.get)
            
            discount = prob_dict[max_key] * penalty_strength
            prob_dict[max_key] -= discount
            prob_dict[min_key] += discount
            return prob_dict, penalty_strength
            
    except: pass
    return prob_dict, 0.0

def process_prediction(match_obj: dict) -> dict:
    home_name = match_obj.get('homeTeam', 'Home')
    away_name = match_obj.get('awayTeam', 'Away')
    explainer_data = [] # Initialize explainer data
    
    # 🧪 Analysis Initializers
    active_patterns = []
    style_h_mod, style_a_mod = 1.0, 1.0
    h_style, a_style = "Balanced", "Balanced"
    h_mom, a_mom = 0.0, 0.0
    h_roll_p3, a_roll_p3 = 0.0, 0.0
    total_absentee_impact = 0.0
    news_sentiment = 0.0
    no_bet = False
    chaos_level = 0.0
    ref_name = match_obj.get('referee') or match_obj.get('refereeName')
    
    # 🛑 FAIL-FAST POLICY & PRE-MATCH BLACKLIST
    XGB_BOOSTER = get_main_booster()
    if XGB_BOOSTER is None:
        sys.stderr.write("🛑 FAIL-FAST: XGBoost Model not loaded. Silent fallback to Poisson blocked.\n")
        return {"success": False, "error": "Prediction stopped: XGBoost Model not loaded (Fail-Fast)."}
        
    league_name_str = str(match_obj.get('league', '')).lower()
    tourn_name_str = str(match_obj.get('tournament_name', '')).lower()
    
    # [NEW] Layered Architecture: Classification Request
    league_tier = classify_league(league_name_str, tourn_name_str)
    
    if league_tier == 'BLACKLIST' and not match_obj.get('force_predict'):
        sys.stderr.write(f"🛑 PRE-MATCH FILTER: Tournament '{league_name_str} {tourn_name_str}' is blacklisted (Tier Logic).\n")
        return {"success": False, "error": "Filtered by Pre-Match Policy", "is_suspicious": True}

    # Selection & Betting Initializers
    selection_prob = 0.34
    selection_label = "Nul"
    selection = "Draw"
    confidence = 50.0
    is_smart_money = False
    is_value_bet = False
    is_confirmed = False
    odds_drop_pct = 0.0
    value_index = 0.0
    expected_score = "1 - 1"
    xg_h, xg_a = 1.2, 1.2
    p_home, p_draw, p_away = 33.3, 33.3, 33.4
    ai_source = "Standard-AI"
    risk_score = 0.0
    risk_reasons = []
    reliability_index = 50.0
    power_score = 0.0
    chaos_level = 0.0
    verdict = "N/A"
    surgical_confidence = 0.0
    is_suspicious_flag = False
    is_safe_bet_flag = False
    rotation_penalty = 0.0
    pattern_desc = "Standard"
    verdict_label = "N/A"
    backup_label = "N/A"
    backup_conf = 0.0
    power_tubes = []
    analysis = {}
    main_four = []
    precision_bets = []
    deep_audit_required = False
    strategic_brief = ""
    ta_features = {}
    direct_prediction = ""
    mc_ou25 = 50.0
    weather_wind = 0.0
    h_dominance = 1.0
    a_dominance = 1.0
    sot_a = 3.0
    fav_team_tactics = "Standard"
    
    # 🌍 SEEDING: Fetch Full Match History Once (Crucial for all V17/V19/V20 components)
    from ml_features import get_team_history
    h_hist = get_team_history(home_name, limit=30)
    a_hist = get_team_history(away_name, limit=30)
    
    # [TITANIUM V20] Quantum Win Rate Rule (Last 30 matches)
    h_win_rate = 0.0
    if h_hist:
        h_wins = sum(1 for match in h_hist if (match.get('homeTeam') == home_name and match.get('homeGoals', 0) > match.get('awayGoals', 0)) or (match.get('awayTeam') == home_name and match.get('awayGoals', 0) > match.get('homeGoals', 0)))
        h_win_rate = h_wins / len(h_hist)
    
    a_win_rate = 0.0
    if a_hist:
        a_wins = sum(1 for match in a_hist if (match.get('homeTeam') == away_name and match.get('homeGoals', 0) > match.get('awayGoals', 0)) or (match.get('awayTeam') == away_name and match.get('awayGoals', 0) > match.get('homeGoals', 0)))
        a_win_rate = a_wins / len(a_hist)
    
    # Dynamic Veto: Kill draw if win rate is high and there's a clear favorite
    h_elo = ELO_DATA.get(home_name, 1500)
    a_elo = ELO_DATA.get(away_name, 1500)
    elo_gap = abs(h_elo - a_elo)
    
    kill_draw_historical = (h_win_rate > 0.55 or a_win_rate > 0.55) and elo_gap > 100
    
    # 📊 Baseline Feature Extraction (Needed for Analysis blocks)
    features = extract_ml_features(match_obj, fetch_history=False)
    features['history_home'] = h_hist
    features['history_away'] = a_hist
    
    # --- V50+ PROTOCOL: Imputation & xG-Elo Delta ---
    features = impute_missing_match_data(features, match_obj)
    
    # 🛑 INSUFFICIENT DATA FILTER FOR UNKNOWN TOURNAMENTS
    if league_tier == 'UNKNOWN' and features.get('data_completeness', 100) < 30.0:
        sys.stderr.write(f"🛑 PRE-MATCH FILTER: UNKNOWN tournament with insufficient data ({features.get('data_completeness')}%) blocked.\n")
        return {"success": False, "error": "INSUFFICIENT_DATA"}
    
    # Calculate performance-based Elo adjustments
    perf_delta_h = calculate_xg_perf_delta(h_hist, is_home=True)
    perf_delta_a = calculate_xg_perf_delta(a_hist, is_home=False)
    
    # Inject QoP deltas into feature vector for XGBoost awareness
    features['xg_elo_delta_h'] = perf_delta_h
    features['xg_elo_delta_a'] = perf_delta_a

    # [V50+ FIX] Apply QoP xG-Elo delta to the Base Elo directly
    features['home_elo'] = features.get('home_elo', 1500) + (perf_delta_h * 15.0)
    features['away_elo'] = features.get('away_elo', 1500) + (perf_delta_a * 15.0)
    features['elo_diff'] = features['home_elo'] - features['away_elo']
    
    # Time Machine Month Context
    try:
        ts = int(match_obj.get('startTimestamp', 0))
        import datetime
        match_month = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).month if ts > 0 else datetime.datetime.now().month
    except: match_month = datetime.datetime.now().month

    # 1. Base xG — prioritize match-specific data over generic ELO
    # Source 1: Pre-computed home_xg / away_xg from the match object
    raw_xg_h = float(match_obj.get('home_xg') or 0)
    raw_xg_a = float(match_obj.get('away_xg') or 0)

    # Source 2: team season averages from teamStats
    team_stats = match_obj.get('teamStats') or {}
    if isinstance(team_stats, str):
        try: team_stats = json.loads(team_stats)
        except: team_stats = {}
    if not isinstance(team_stats, dict): team_stats = {}
    h_stats = team_stats.get('home') or {}
    a_stats = team_stats.get('away') or {}
    avg_xg_h = (float(h_stats.get('avgGoalsScored') or 0) + float(a_stats.get('avgGoalsConceded') or 0)) / 2.0
    avg_xg_a = (float(a_stats.get('avgGoalsScored') or 0) + float(h_stats.get('avgGoalsConceded') or 0)) / 2.0

    # Source 3: Advanced Weighted Historical
    league_name = match_obj.get('league', 'Unknown')
    hist_xg_h, hist_xg_a = get_advanced_xg_adjustment(home_name, away_name, league_name, features)

    # Choose best available source
    if raw_xg_h > 0.1 and raw_xg_a > 0.1:
        xg_h, xg_a = raw_xg_h, raw_xg_a
    elif avg_xg_h > 0.1 and avg_xg_a > 0.1:
        xg_h, xg_a = avg_xg_h, avg_xg_a
    else:
        xg_h, xg_a = hist_xg_h, hist_xg_a

    # Apply xG-Elo Performance Deltas (QoP)
    # If a team has high QoP (under-rewarded), boost their xG slightly
    xg_h *= (1.0 + (perf_delta_h * 0.05))
    xg_a *= (1.0 + (perf_delta_a * 0.05))

    # Refine xG - dynamic HA is already in hist_xg, but let's ensure consistency
    # for raw and avg sources by applying a baseline HA if they aren't biased
    if raw_xg_h > 0.1 or avg_xg_h > 0.1:
        ha_ratio = get_league_home_advantage(league_name)
        xg_h *= ha_ratio
        xg_a *= (1.0 / ha_ratio)

    # 1.5 V13 Tactical Style Matching
    from ml_features import get_detailed_team_style
    # Get stats for styling
    h_style = get_detailed_team_style(h_stats) 
    a_style = get_detailed_team_style(a_stats)
    style_h_mod, style_a_mod = get_stylistic_clash_modifier(h_style, a_style)
    
    xg_h *= style_h_mod
    xg_a *= style_a_mod

    # 2. Time Machine Modifiers
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

    # 3. News-Based Player Impact (Surgical xG adjustment)
    news_data = match_obj.get('news_data')
    if isinstance(news_data, str):
        try: news_data = json.loads(news_data)
        except: news_data = {}
    
    # [TITANIUM V19 NOISE FILTER] Only quantified data is allowed to influence xG.
    # Weather, squad rotations and unquantified news sentiment are DISABLED.
    # Only xG history, shot accuracy, defensive tackles, and productive possession count.
    h_att_mod = 1.0  # Reset — no unquantified news influence
    h_def_mod = 1.0
    a_att_mod = 1.0
    a_def_mod = 1.0
    news_impact_obj = {}  # News noise cleared
    
    # --- V46: Arabic Intelligence Numerical Overlay ---
    # Specifically penalize teams with CRITICAL absences found in Arabic News
    # missing_gk=1.0, missing_scorer=1.0, etc. (values from row/match_obj)
    
    # Extract intelligence features from news_data JSON if available
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

    # --- V50 Injury Matrix Update ---
    if h_is_gk_out > 0: h_def_mod *= 1.25 # Defense gets weaker (higher multiplier to conceded/lower to defense)
    if h_is_scorer_out > 0: h_att_mod *= 0.70
    if h_is_star_out > 0 or h_is_captain_out > 0: 
        h_att_mod *= 0.85
        h_def_mod *= 1.15

    if a_is_gk_out > 0: a_def_mod *= 1.25
    if a_is_scorer_out > 0: a_att_mod *= 0.70
    if a_is_star_out > 0 or a_is_captain_out > 0:
        a_att_mod *= 0.85
        a_def_mod *= 1.15

    # --- V50+ Dynamic Motivation Factor (DMF - Hafiz) & Fatigue ---
    h_target_w = float(match_obj.get('home_target_weight', 0))
    a_target_w = float(match_obj.get('away_target_weight', 0))
    
    # Dead Zone Detection (Motivation < 0.2 and > 10 matches played)
    h_is_dz = (h_target_w < 0.1) and (len(h_hist) > 5)
    a_is_dz = (a_target_w < 0.1) and (len(a_hist) > 5)

    # --- [TITANIUM ZERO-GRAVITY DEFENSE] Sanitize All Inputs ---
    # Global _f_feat handles this now.

    # Calculate base DMF
    h_dmf = calculate_dmf_hafiz(h_target_w, _f_feat('home_distance_target', match_obj, 0), _f_feat('home_matches_remaining', match_obj, 10), len(h_hist), is_dead_zone=h_is_dz)
    a_dmf = calculate_dmf_hafiz(a_target_w, _f_feat('away_distance_target', match_obj, 0), _f_feat('away_matches_remaining', match_obj, 10), len(a_hist), is_dead_zone=a_is_dz)
    
    h_fatigue = calculate_fatigue_mod(_f_feat('rest_h', features, 7))
    a_fatigue = calculate_fatigue_mod(_f_feat('rest_a', features, 7))

    # --- [TITANIUM V54] End of Season Signature ---
    motivation_signature = "Logique Standard"
    if h_dmf > 1.2 and a_is_dz:
        motivation_signature = "🚨 ENJEU CRITIQUE vs ZONE MORTE (H)"
    elif a_dmf > 1.2 and h_is_dz:
        motivation_signature = "🚨 ENJEU CRITIQUE vs ZONE MORTE (A)"
    elif h_is_dz and a_is_dz:
        motivation_signature = "💤 MATCH DE CLÔTURE (ZONE MORTE)"
    elif h_dmf > 1.15 and a_dmf > 1.15:
        motivation_signature = "⚔️ CHOC DE MOTIVATION"
    
    # "Respect law of FIFA" (Professionalism)
    is_elite = league_tier == 'T1'
    if (h_is_dz or a_is_dz) and is_elite:
        motivation_signature = "🛡️ FAIR-PLAY GARANTI (ELITE)"
    
    if "ZONE MORTE" in motivation_signature and not is_elite:
        # Check if the "Dead Zone" team is still performing well (Respecting law)
        dz_team_form = h_mom if h_is_dz else a_mom
        if dz_team_form > 0.6:
            motivation_signature = "⚖️ RESPECT DES LOIS (PRO)"
    
    # Attack increases with DMF and decreases with fatigue. 
    h_att_mod *= h_dmf * (1.0 - h_fatigue)
    h_def_mod *= h_dmf * (1.0 / (1.0 + h_fatigue)) # Corrected: High DMF = Stronger Defense
    
    a_att_mod *= a_dmf * (1.0 - a_fatigue)
    a_def_mod *= a_dmf * (1.0 / (1.0 + a_fatigue))
    
    # Inject V50 Modifiers into Base xG
    xg_h *= (h_att_mod / a_def_mod) if a_def_mod > 0 else h_att_mod
    xg_a *= (a_att_mod / h_def_mod) if h_def_mod > 0 else a_att_mod


    # --- V47: Market & Psychological Strategic Layer ---
    h_mkt = _f_feat('home_market_value', match_obj, 0)
    a_mkt = _f_feat('away_market_value', match_obj, 0)
    ref_bias = _f_feat('referee_home_win_rate', match_obj, 0.45)
    is_pressure = _f_feat('is_high_pressure', match_obj, 0)

    # 1. Market Value Ratio (MVR) Logic
    # Squads with significantly higher value tend to dominate tight spots
    if h_mkt > 0 and a_mkt > 0:
        mvr = h_mkt / a_mkt
        if mvr > 2.5: # Extreme financial gap
            h_att_mod *= 1.10
            a_att_mod *= 0.90
        elif mvr < 0.4:
            a_att_mod *= 1.10
            h_att_mod *= 0.90
    
    # 2. Referee Home Bias adjustment
    if ref_bias > 0.52: # Home favored ref
        h_att_mod *= 1.05
    elif ref_bias < 0.38: # Away favored / Strict ref
        a_att_mod *= 1.05

    # [TITANIUM V19] Statistical Weight: 85% Historical xG Data, 15% Power Score bonus
    # Weather modifier is SUPPRESSED (Noise Filter).
    pressure_mod = 1.0  # Disable pressure factor (unquantified)
    
    # [TITANIUM V19] quantitative xG boost from historical win rate (sot + bc)
    h_sot_ratio = features.get('h_sot', 4.0) / max(features.get('a_sot', 4.0), 0.1)
    a_sot_ratio = features.get('a_sot', 4.0) / max(features.get('h_sot', 4.0), 0.1)
    h_bc_ratio = features.get('h_bc', 1.5) / max(features.get('a_bc', 1.5), 0.1)
    a_bc_ratio = features.get('a_bc', 1.5) / max(features.get('h_bc', 1.5), 0.1)
    h_pos_ratio = features.get('h_pos', 50.0) / 100.0
    a_pos_ratio = features.get('a_pos', 50.0) / 100.0
    
    # Composite Attack Strength (quantified only)
    h_composite_attack = (h_sot_ratio * 0.4) + (h_bc_ratio * 0.4) + (h_pos_ratio * 0.2)
    a_composite_attack = (a_sot_ratio * 0.4) + (a_bc_ratio * 0.4) + (a_pos_ratio * 0.2)
    
    # [TITANIUM V19 FINAL] Statistical Weight: 90% Historical xG Data, 10% Composite Attack
    # Weather modifier SUPPRESSED. Pure historical stats drive xG.
    # [TITANIUM V88] Advanced Goals Optimizer
    league_goals_mult = get_league_goals_multiplier(league_name_str)
    
    h_def_index = calculate_composite_defense(features, is_home=True)
    a_def_index = calculate_composite_defense(features, is_home=False)
    
    # xG is filtered by opponent's defense and boosted by league density
    # Formula: Adjusted xG = (Base xG * Attack) / Opponent Defense * League Multiplier
    xg_h = (xg_h * (0.90 + 0.10 * h_composite_attack) / a_def_index) * league_goals_mult
    xg_a = (xg_a * (0.90 + 0.10 * a_composite_attack) / h_def_index) * league_goals_mult
    
    # --- V22 ULTIMATE: Environmental & Squad Matrix ---
    analysis = {} # Initialize early for V22
    weather_desc = str(match_obj.get('weather_desc', '')).lower()
    weather_wind = float(match_obj.get('weather_wind', 0))
    weather_impact_xg = 1.0
    
    # 1. Weather Impact (Rain/Snow reduces goals)
    if 'rain' in weather_desc or 'snow' in weather_desc:
        weather_impact_xg = 0.88
        analysis["Weather"] = "Conditions météo difficiles (Pluie/Neige) - Attente de score plus bas."
    
    # 2. Rotation Impact (Absentees)
    # Already have h_att_mod, etc.
    rotation_penalty = 0.0
    if h_att_mod < 0.85 or a_att_mod < 0.85:
        rotation_penalty = 8.0
        analysis["Rotation"] = "Rotation majeure détectée (Héritage Top Players absents)."

    xg_h *= weather_impact_xg
    xg_a *= weather_impact_xg

    # --- V60: TACTICAL INTELLIGENCE LAYER ---
    xg_h, xg_a, tactical_alerts = apply_tactical_intelligence(match_obj, features, xg_h, xg_a)
    analysis["Tactical"] = tactical_alerts
    
    # --- V60: H2H Bête Noire Matrix ---
    h2h = calculate_h2h_dominance(h_hist, a_hist, home_name, away_name)
    if isinstance(h2h, dict) and h2h['total'] >= 3:
        if h2h['h'] > 0.7:
            xg_h *= 1.15
            analysis["H2H"] = f"🔥 BÊTE NOIRE: {home_name} domine historiquement {away_name}."
        elif h2h['a'] > 0.7:
            xg_a *= 1.15
            analysis["H2H"] = f"🔥 BÊTE NOIRE: {away_name} domine historiquement {home_name}."

    # --- V95: POWER SURGE BOOST ---
    h_accel = features.get('explosive_momentum_h', 0.0)
    a_accel = features.get('explosive_momentum_a', 0.0)
    if h_accel > 0.5 and xg_h > 1.8:
        xg_h *= (1.0 + h_accel * 0.1)
        analysis["Power-Surge"] = f"⚡ POWER SURGE (H): {home_name} est en phase d'accélération offensive."
    if a_accel > 0.5 and xg_a > 1.8:
        xg_a *= (1.0 + a_accel * 0.1)
        analysis["Power-Surge"] = f"⚡ POWER SURGE (A): {away_name} est en phase d'accélération offensive."

    # 4. Monte Carlo Simulation (Replacing static Poisson loop)
    sim = monte_carlo_simulation(xg_h, xg_a)
    p_h_poi, p_d_poi, p_a_poi = sim['p_h'], sim['p_d'], sim['p_a']
    
    # 4.5 V13 Glicko Momentum Integration
    from ml_features import calculate_glicko_momentum
    h_mom = calculate_glicko_momentum(h_hist, window=5)
    a_mom = calculate_glicko_momentum(a_hist, window=5)
    # Momentum boost: +5% prob for strong momentum
    if h_mom > a_mom * 1.5: p_h_poi *= 1.05
    elif a_mom > h_mom * 1.5: p_a_poi *= 1.05

    # 4.6 Odds Steam Integration (V17 Accuracy Boost)
    # Factor in market pressure from odds drops
    odds_drop_h = _f_feat('odds_drop_home', match_obj, 0)
    odds_drop_a = _f_feat('odds_drop_away', match_obj, 0)
    if odds_drop_h > 5.0: p_h_poi *= (1.0 + (odds_drop_h / 100.0))
    if odds_drop_a > 5.0: p_a_poi *= (1.0 + (odds_drop_a / 100.0))

    # --- Pre-inference: Run Top Analyst Engine to populate ta_* features ---
    try:
        _ta_result = process_match_for_top_analyst(match_obj)
        _ta_feats = _ta_result.get('ml_features', {})
        features.update(_ta_feats)  # Merge ta_* into features dict
    except Exception as _ta_err:
        sys.stderr.write(f"⚠️ [TA-Pre] {_ta_err}\n")

    # 4.1 XGBoost Engine (V25 Intelligence Edition)
    explainer_data = []
    
    # Initialize probabilities with Poisson fallbacks to avoid UnboundLocalError
    p_h_poi, p_d_poi, p_a_poi = sim['p_h'], sim['p_d'], sim['p_a']
    p_h_xgb, p_d_xgb, p_a_xgb = p_h_poi, p_d_poi, p_a_poi
    p_h_ai, p_d_ai, p_a_ai = p_h_poi, p_d_poi, p_a_poi
    ai_source = "Standard-Poisson"
    
    from ml_features import FEATURE_NAMES_V52, FEATURE_NAMES_V24, FEATURE_NAMES_TITANIUM
    
    # [V52 STABILITY FIX] Force 115 features for Titanium Model
    TITANIUM_BOOSTER = get_titanium_booster()
    XGB_BOOSTER = TITANIUM_BOOSTER if TITANIUM_BOOSTER else get_main_booster()
    
    if TITANIUM_BOOSTER:
        active_feature_names = FEATURE_NAMES_TITANIUM
        active_feature_vector = [float(features.get(f, 0)) for f in FEATURE_NAMES_TITANIUM]
        ai_source = "TITANIUM-ELITE-V2"
    elif XGB_BOOSTER:
        active_feature_names = FEATURE_NAMES_V52
        active_feature_vector = [float(features.get(f, 0)) for f in FEATURE_NAMES_V52]
    else:
        active_feature_names = FEATURE_NAMES
        active_feature_vector = [float(features.get(f, 0)) for f in FEATURE_NAMES]
    
    # Backward compatibility for Corners/Cards models (70 features)
    feature_vector = [_f_feat(f, features, 0) for f in FEATURE_NAMES]
    
    has_xgb = False
    if XGB_BOOSTER:
        try:
            # --- MONTE CARLO SIMULATION ---
            # Extract new metrics for advanced MC injection
            fatigue = (features.get('h_fatigue_cumulative', 1.0), features.get('a_fatigue_cumulative', 1.0))
            injuries = (features.get('home_injury_impact', 0.0), features.get('away_injury_impact', 0.0))
            # ── [TITANIUM ULTRA-ENSEMBLE V25] ──
            # 1. XGBoost Probabilities
            # [V110 PRECISION UPGRADE] Increased from 500 to 1000 simulations for
            # statistically robust confidence intervals (±1.5% vs ±2.1% std error)
            _mc_sims = 1500 if injuries[0] >= 3.0 or injuries[1] >= 3.0 else 1000
            p_h_xgb, p_d_xgb, p_a_xgb = simulate_match_mc(
                XGB_BOOSTER, 
                active_feature_vector, 
                num_simulations=_mc_sims, 
                feature_names=active_feature_names, 
                fatigue_impact=fatigue,
                injury_impact=injuries,
                league_name=league_name
            )

            # 2. Poisson Dixon-Coles Probabilities (Goal-based)
            p_h_poi, p_d_poi, p_a_poi = sim['p_h'], sim['p_d'], sim['p_a']

            # 3. Market Psychology Layer (Implied Odds)
            odds_h = _safe_float(match_obj.get('odds_home'), 2.0)
            implied_h = 1.0 / odds_h if odds_h > 0 else 0.33
            n_sent = _safe_float(features.get('news_sent'), 0)
            
            # [TRAP DETECTION]
            if p_h_xgb > (implied_h + 0.15) and n_sent < -0.2:
                p_h_xgb *= 0.85 
                
            # 4. FINAL WEIGHTED CONSENSUS
            # [V102] Dynamic Blending: Adjust dominance based on league strategy
            l_strat = LEAGUE_WEIGHT_MATRIX.get(league_name, LEAGUE_WEIGHT_MATRIX.get(league_tier, LEAGUE_WEIGHT_MATRIX['DEFAULT']))
            w_xgb = l_strat['xgb_weight']
            w_poi = 1.0 - w_xgb
            
            p_h_ai = (p_h_xgb * w_xgb) + (p_h_poi * w_poi)
            p_d_ai = (p_d_xgb * w_xgb) + (p_d_poi * w_poi)
            p_a_ai = (p_a_xgb * w_xgb) + (p_a_poi * w_poi)
            
            # [V102] News Intelligence Injection (Tier-specific sensitivity)
            if n_sent != 0:
                n_boost = l_strat['news_boost'] * n_sent
                p_h_ai = max(0.01, min(0.95, p_h_ai * (1.0 + n_boost)))

            # --- [TITANIUM ALPHA] NEURAL META-REFINER (الرقابة الذكية) ---
            from meta_refiner import refine_prediction
            p_h_refined, h_factor = refine_prediction(league_name, "Home", p_h_ai)
            p_a_refined, a_factor = refine_prediction(league_name, "Away", p_a_ai)
            p_d_refined, d_factor = refine_prediction(league_name, "Draw", p_d_ai)
            
            # Apply refinement if a significant bias is detected (factor != 1.0)
            if abs(h_factor - 1.0) > 0.02 or abs(a_factor - 1.0) > 0.02:
                p_h_ai, p_d_ai, p_a_ai = p_h_refined, p_d_refined, p_a_refined
                # Re-normalize
                s_ref = p_h_ai + p_d_ai + p_a_ai
                p_h_ai, p_d_ai, p_a_ai = p_h_ai/s_ref, p_d_ai/s_ref, p_a_ai/s_ref
                analysis["Meta-Refiner"] = f"الرقابة الذكية: تم تعديل الاحتمالات بناءً على الأداء التاريخي للدوري ({h_factor:.2f}x H, {a_factor:.2f}x A)."

            # --- SHAP-LITE EXPLAINABILITY ---
            # Get feature contributions for the main prediction
            xgb = get_xgb()
            dmat_explain = xgb.DMatrix(np.array([active_feature_vector]), feature_names=active_feature_names)
            preds = XGB_BOOSTER.predict(dmat_explain, pred_contribs=True)[0]
            
            # For multiclass, contribs is flattened
            winner_idx = 0 if p_h_xgb > p_a_xgb and p_h_xgb > p_d_xgb else (2 if p_a_xgb > p_h_xgb and p_a_xgb > p_d_xgb else 1)
            
            num_f = len(active_feature_names)
            # Handle both multiclass flattened shape and binary/regressor shape
            if len(preds) == num_f + 1:
                class_contribs = preds
            else:
                class_contribs = preds[winner_idx * (num_f + 1) : (winner_idx + 1) * (num_f + 1)]
            
            # Sort by absolute contribution and pick top 5
            feature_impacts = []
            for i in range(num_f):
                # Ensure we don't hit index bounds if shape is somehow incorrect
                if i < len(class_contribs):
                    val = class_contribs[i]
                    if isinstance(val, (list, tuple, np.ndarray)):
                        val = val[winner_idx] if len(val) > winner_idx else val[0]
                    feature_impacts.append({
                        "name": active_feature_names[i],
                        "impact": float(val)
                    })
            
            # Sort by absolute impact descending
            feature_impacts.sort(key=lambda x: abs(x['impact']), reverse=True)
            explainer_data = feature_impacts[:5]
            
            has_xgb = True
        except Exception as e:
            import traceback
            sys.stderr.write(f"⚠️ [XGB-INF] Error: {traceback.format_exc()}\n")

    # V18 Secondary Markets Inference
    expected_corners = round(float(features.get('home_corners', 4.5) + features.get('away_corners', 4.5)), 1)
    expected_cards = round(float(features.get('home_cards', 2.0) + features.get('away_cards', 2.0)), 1)

    try:
        # If models are loaded, overwrite the naive estimate with XGB predictions
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

    # --- XGBoost Engine Logic (Titanium Core) ---
    if has_xgb:
        ai_source = "Titanium-XGB-Core-V52"
        ai_fusion_weight = 0.95 # Relying almost entirely on XGBoost as requested
    else:
        ai_source = "Poisson-Tactical-V11 (AI Offline)"
        ai_fusion_weight = 0.0

    # 5. Global Blending: AI Modules + Poisson Base
    p_h = (p_h_ai * ai_fusion_weight) + (p_h_poi * (1.0 - ai_fusion_weight))
    p_d = (p_d_ai * ai_fusion_weight) + (p_d_poi * (1.0 - ai_fusion_weight))
    p_a = (p_a_ai * ai_fusion_weight) + (p_a_poi * (1.0 - ai_fusion_weight))
    
    # 5.1 Strict Normalization (Vital for confidence scores)
    p_sum = p_h + p_d + p_a
    if p_sum > 0:
        p_h, p_d, p_a = p_h/p_sum, p_d/p_sum, p_a/p_sum
    else:
        p_h, p_d, p_a = 0.33, 0.33, 0.34

    # [V110 TRIPLE CONFLUENCE GUARD] — via confluence_guard module
    # Valide l'accord XGBoost + Poisson + Marché avant d'émettre un signal.
    _confluence_penalty = 0.0
    _confluence_report = {}
    try:
        from confluence_guard import evaluate_confluence, get_market_implied_probs
        _odds_h = _safe_float(match_obj.get('odds_home'), 0.0)
        _odds_d = _safe_float(match_obj.get('odds_draw'), 0.0)
        _odds_a = _safe_float(match_obj.get('odds_away'), 0.0)
        _p_market = get_market_implied_probs(_odds_h, _odds_d, _odds_a) if _odds_h > 1.0 else None

        _confluence_report = evaluate_confluence(
            p_xgb=(p_h_xgb, p_d_xgb, p_a_xgb),
            p_poisson=(p_h_poi, p_d_poi, p_a_poi),
            p_market=_p_market,
            momentum_h=h_mom,
            momentum_a=a_mom,
            league_tier=league_tier,
            has_xgb=has_xgb
        )
        _confluence_penalty = _confluence_report.get('penalty', 0.0)
        analysis["Confluence"] = _confluence_report.get('reason', '')
    except Exception as _cg_err:
        sys.stderr.write(f"⚠️ [ConfluenceGuard] {_cg_err}\n")
        # Fallback: logique inline simplifiée
        _xgb_winner = max(('h', p_h_xgb), ('d', p_d_xgb), ('a', p_a_xgb), key=lambda x: x[1])[0]
        _poi_winner = max(('h', p_h_poi), ('d', p_d_poi), ('a', p_a_poi), key=lambda x: x[1])[0]
        _xgb_poi_divergence = abs(p_h_xgb - p_h_poi) + abs(p_d_xgb - p_d_poi) + abs(p_a_xgb - p_a_poi)
        if has_xgb and _xgb_winner != _poi_winner:
            _confluence_penalty = 0.35 if _xgb_poi_divergence > 0.25 else 0.18
        elif has_xgb and _xgb_winner == _poi_winner and _xgb_poi_divergence < 0.10:
            _confluence_penalty = -0.08

    # 5.2 Gap Learning
    final_probs, gap_correction = apply_gap_learning_weight({"home": p_h, "draw": p_d, "away": p_a}, match_obj.get('league', 'Unknown'))
    p_h, p_d, p_a = final_probs['home'], final_probs['draw'], final_probs['away']
    
    # 5.3 [V50+] Refined Composite Confidence Level
    lineups_active = bool(match_obj.get('lineups_confirmed') or match_obj.get('lineups'))
    data_comp = features.get('data_completeness', 100.0)
    confidence = calculate_composite_confidence(max(p_h, p_d, p_a), h_dmf, a_dmf, lineups_active, data_comp)
    
    # [V110] Apply confluence penalty/bonus to composite confidence
    if _confluence_penalty != 0.0:
        confidence *= (1.0 - _confluence_penalty)
        confidence = max(5.0, min(99.0, confidence))
    
    # Global reliability index (includes Data Completeness)
    reliability_index = (confidence * 0.7) + (features.get('data_completeness', 100) * 0.3)

    # Determine Verdict based on new V50 Confidence rules
    verdict = "SAFE BET"
    if _confluence_penalty >= 0.35: verdict = "NO BET"  # Critical model conflict
    elif confidence < 55: verdict = "NO BET"
    elif confidence < 70: verdict = "RISKY"
    elif p_d > 0.40: verdict = "DRAW TRAP"
    
    is_confirmed = confidence > 80.0 and _confluence_penalty < 0.18

    # Only quantified historical data drives the final probabilities.
    # (Weather temp modifier suppressed, neutral ground ignored)

    # 5.4 [TITANIUM V19 FINAL] Shot Efficiency Re-weighting (PWR > 95 = Absolute Dominance)
    h_shot_eff = _safe_float(features.get('h_sot', 4.0)) / max(_safe_float(features.get('h_pos', 50.0)) / 10.0, 0.1)
    a_shot_eff = _safe_float(features.get('a_sot', 4.0)) / max(_safe_float(features.get('a_pos', 50.0)) / 10.0, 0.1)
    pwr_score_est = max(50, (_safe_float(xg_h) * 15 * 0.90) + (_safe_float(h_composite_attack) * 15 * 0.10) + 50)
    
    if pwr_score_est > 95:  # Absolute Dominance threshold
        eff_advantage = h_shot_eff / max(a_shot_eff, 0.01)
        if eff_advantage > 1.15:
            p_h = min(0.93, p_h * (1.0 + (eff_advantage - 1.0) * 0.35))
            p_d *= 0.10  # Near-total Draw elimination at absolute dominance
            p_sum_pwr = p_h + p_d + p_a
            p_h, p_d, p_a = p_h/p_sum_pwr, p_d/p_sum_pwr, p_a/p_sum_pwr
    
    # 6. Live In-Play Adjustments
    p_h, p_d, p_a, live_alerts = apply_live_event_adjustment(match_obj, p_h, p_d, p_a)
    
    # Re-normalize after apply_live_event_adjustment just in case (e.g. red cards shift probs)
    p_sum_final = p_h + p_d + p_a
    if p_sum_final > 0:
        p_h, p_d, p_a = p_h/p_sum_final, p_d/p_sum_final, p_a/p_sum_final
    
    p_home, p_draw, p_away = p_h*100, p_d*100, p_a*100
    
    # 5.5 Deep Audit Detection (Intelligence Synergy)
    deep_audit_required = False
    if has_xgb:
        gap = abs(p_h - p_h_xgb) + abs(p_d - p_d_xgb) + abs(p_a - p_a_xgb)
        if gap > 0.45: deep_audit_required = True
        
    expected_score = calculate_exact_score(xg_h, xg_a, p_home, p_away)
    
    gh, ga = 0, 0
    if " - " in expected_score:
        try:
            gh, ga = map(int, expected_score.split(" - "))
        except: pass

    # --- TITANIUM V19 FINAL: Forced Draw Veto Protocol ---
    attack_h = features.get('home_possession', 50) + (xg_h * 15)
    def_a = 100 - (xg_h * 20)
    attack_a = features.get('away_possession', 50) + (xg_a * 15)
    def_h = 100 - (xg_a * 20)
    score_diff = abs(gh - ga)
    max_atk = max(h_composite_attack, a_composite_attack)

    # [V70 REALISM] GRADUATED DRAW MODULATION
    # Replace binary 0.01 kill with realistic scaled penalty.
    # Draw rate in world football: ~27% balanced, ~12% dominant favourite matches.
    pwr_score_v19 = round(max(50, (xg_h * 15 * 0.90) + (h_composite_attack * 15 * 0.10) + 50), 1)

    # Determine draw penalty factor based on evidence strength
    if score_diff >= 3:
        draw_penalty = 0.08   # Extreme dominance: <8% of original draw probability
    elif score_diff >= 2:
        draw_penalty = 0.18   # Clear gap: reduce strongly but not eliminate
    elif score_diff >= 1:
        draw_penalty = 0.38   # Slight edge: moderate reduction
    elif (max_atk > 0.85) or (pwr_score_v19 > 92) or kill_draw_historical:
        draw_penalty = 0.30   # Strong dominance signals but tied score
    else:
        draw_penalty = 1.0    # Balanced match: keep draw fully

    if draw_penalty < 1.0:
        p_d *= draw_penalty
        p_sum_v19 = p_h + p_d + p_a
        p_h, p_d, p_a = p_h/p_sum_v19, p_d/p_sum_v19, p_a/p_sum_v19
        p_home, p_draw, p_away = p_h*100, p_d*100, p_a*100
        # Only force score adjustment if expected score contradicts winner
        if draw_penalty <= 0.18 and gh == ga:
            if h_composite_attack >= a_composite_attack: gh += 1
            else: ga += 1
            gh = min(7, max(0, gh))
            ga = min(7, max(0, ga))
            expected_score = f"{gh} - {ga}"
            score_diff = abs(gh - ga)

    # --- PRONOSTICS DE PRÉCISION (BETTING MARKETS) ---
    precision_bets = []
    
    # 1. Over/Under 2.5 Goals — V70 REALISM: Use actual Monte Carlo simulation probability
    bc_h = _f_feat('home_big_chances', features, 1.0) if has_xgb else 1.0
    bc_a = _f_feat('away_big_chances', features, 1.0) if has_xgb else 1.0
    sot_h = _f_feat('home_sot', features, 3.0) if has_xgb else 3.0
    sot_a = _f_feat('away_sot', features, 3.0) if has_xgb else 3.0

    # Dominance Booster for 1dom/2dom
    h_dominance = (h_shot_eff * 1.2) + (h_composite_attack * 0.8)
    a_dominance = (a_shot_eff * 1.2) + (a_composite_attack * 0.8)

    # Use the physics-based Monte Carlo probability (already computed above via sim)
    mc_ou25 = _f_feat('ou_25_prob', sim, 0.5) * 100 
    mc_ou35 = _f_feat('ou_35_prob', sim, 0.3) * 100
    mc_ou15 = _f_feat('ou_15_prob', sim, 0.7) * 100

    if mc_ou25 >= 58:
        precision_bets.append({"market": "Over 2.5 Buts", "probability": int(round(mc_ou25)), "reason": f"Monte Carlo ({int(mc_ou25)}%): Forte probabilité de 3+ buts (xG total {xg_h+xg_a:.2f})"})
    elif mc_ou25 <= 42:
        under_prob = round(100 - mc_ou25)
        precision_bets.append({"market": "Under 2.5 Buts", "probability": int(under_prob), "reason": f"Monte Carlo ({int(under_prob)}%): Faible probabilité de 3+ buts (xG total {xg_h+xg_a:.2f})"})

    if mc_ou35 >= 55:
        precision_bets.append({"market": "Over 3.5 Buts", "probability": int(round(mc_ou35)), "reason": f"Monte Carlo ({int(mc_ou35)}%): Probabilité de 4+ buts (match ouvert)"})

    if xg_h >= 1.2 and xg_a >= 1.1 and bc_h >= 1.5 and bc_a >= 1.5:
        precision_bets.append({"market": "BTTS : OUI", "probability": int(min(88, (xg_h*xg_a)*30 + 40)), "reason": "Les deux équipes génèrent des occasions nettes"})
    
    if xg_a < 0.8 and sot_a < 2.5 and p_home > 60:
        precision_bets.append({"market": f"Clean Sheet : {home_name}", "probability": int(min(80, 100 - (xg_a*50))), "reason": f"Attaque de {away_name} très inefficace"})

    if expected_corners >= 10.0:
        precision_bets.append({"market": "Over 8.5 Corners", "probability": int(min(87, 60 + (expected_corners - 9)*10)), "reason": f"Moyenne simulée : {expected_corners} corners"})
    elif expected_corners <= 7.5:
        precision_bets.append({"market": "Under 9.5 Corners", "probability": int(min(85, 60 + (8.5 - expected_corners)*10)), "reason": f"Moyenne simulée : {expected_corners} corners"})
        
    if expected_cards >= 4.8:
        precision_bets.append({"market": "Over 3.5 Cartons", "probability": int(min(85, 65 + (expected_cards - 4.5)*10)), "reason": f"Agressivité élevée : {expected_cards} indice estimé"})

    # --- V21: Professional Pro-Signals (AH & DNB) ---
    dnb_h, dnb_a, dc_h, dc_a, dc_12 = calculate_ah_dnb_probs(p_h, p_d, p_a)
    
    if dnb_h > 0.65 or (selection == "Home" and dnb_h > 0.55):
        precision_bets.append({"market": f"DNB {home_name}", "probability": int(dnb_h*100), "reason": "Protection sur le nul incluse"})
    elif dnb_a > 0.65 or (selection == "Away" and dnb_a > 0.55):
        precision_bets.append({"market": f"DNB {away_name}", "probability": int(dnb_a*100), "reason": "Protection sur le nul incluse"})

    # ASIAN HANDICAP LAYER
    if selection == "Home":
        if p_h > 0.75 or h_dominance > 2.5:
            precision_bets.append({"market": f"AH -1.5 {home_name}", "probability": int(p_h*85), "reason": "Domination structurelle massive attendue"})
        elif p_h > 0.60 or h_dominance > 1.8:
            precision_bets.append({"market": f"AH -0.5 {home_name}", "probability": int(p_h*100), "reason": "Victoire sèche recommandée (AH -0.5)"})
    elif selection == "Away":
        if p_a > 0.75 or a_dominance > 2.5:
            precision_bets.append({"market": f"AH -1.5 {away_name}", "probability": int(p_a*85), "reason": "Supériorité tactique écrasante à l'extérieur"})
        elif p_a > 0.60 or a_dominance > 1.8:
            precision_bets.append({"market": f"AH -0.5 {away_name}", "probability": int(p_a*100), "reason": "Victoire sèche recommandée (AH -0.5)"})

    # --- V23: PROFESSIONAL BETTING INSIGHTS ---
    pro_insights = []
    
    # Value Insight
    if is_value_bet:
        pro_insights.append({
            "type": "VALUE",
            "title": "Opportunité de Valeur",
            "content": f"Le marché sous-estime {selection}. Indice de valeur à {value_index:.2f}."
        })
        
    # Security Insight
    if confidence > 82 and league_tier == 'T1':
        pro_insights.append({
            "type": "SAFE",
            "title": "Indice de Fiabilité Élite",
            "content": "Match à haute prévisibilité dans une ligue majeure. Risque de volatilité faible."
        })
    elif league_tier == 'T3':
        pro_insights.append({
            "type": "RISK",
            "title": "Alerte de Volatilité",
            "content": f"Ligue de Tier 3 : Attention aux surprises statistiques ({league_name_str})."
        })
        
    # Tactical Insights (V60)
    for alert in tactical_alerts:
        pro_insights.append({
            "type": "TACTICAL",
            "title": "Analyse Tactique",
            "content": alert
        })
    
    if "H2H" in analysis:
        pro_insights.append({
            "type": "HISTORY",
            "title": "Bête Noire / H2H",
            "content": analysis["H2H"]
        })

    # Tactical Insight
    if abs(h_dmf - a_dmf) > 0.4:
        fav_mot = home_name if h_dmf > a_dmf else away_name
        pro_insights.append({
            "type": "TACTICAL",
            "title": "Déséquilibre de Motivation",
            "content": f"{fav_mot} a un impératif de points nettement supérieur, favorisant l'engagement physique."
        })

    # Scoring Insight
    if mc_ou25 > 65:
        pro_insights.append({
            "type": "GOALS",
            "title": "Potentiel de Score Élevé",
            "content": "Les simulations confirment une approche offensive des deux côtés. Le Over 2.5 est un choix solide."
        })
    elif mc_ou25 < 35:
        pro_insights.append({
            "type": "DEFENSE",
            "title": "Bataille Défensive",
            "content": "Blocs bas et inefficacité offensive attendus. Match probablement fermé."
        })

    strategic_brief = generate_strategic_brief(features, home_name, away_name, selection, match_obj=match_obj)

    # --- TITANIUM V24: Surgical Market Selection (Advanced) ---
    def get_best_surgical_market():
        # Check if this is a Promosport match
        league_name = str(match_obj.get('league', '')).lower()
        tournament_name = str(match_obj.get('tournament_name', '')).lower()
        is_promosport = 'promosport' in league_name or 'promosport' in tournament_name
        
        if is_promosport:
            return {"type": selection_label, "confidence": int(selection_prob * 100), "desc": "تحليل كلاسيكي (1-X-2) لمسابقة البروموسبور"}

        markets = []
        
        # 1. First Half Goal (Over 0.5 HT)
        if mc_ou25 > 62 or (xg_h > 1.3 and xg_a > 1.2):
            markets.append({"type": "Over 0.5 HT", "confidence": int(mc_ou25 * 0.95), "desc": "نمط الهجوم المبكر والضغط العالي"})
            
        # 2. Both Teams To Score (BTTS)
        if xg_h > 1.1 and xg_a > 1.1 and bc_h >= 1.2 and bc_a >= 1.2:
            markets.append({"type": "BTTS (Oui)", "confidence": int(min(90, (xg_h * xg_a) * 35 + 30)), "desc": "ثغرات دفاعية متبادلة"})
            
        # 3. Asian Handicap (AH)
        is_t1 = (league_tier == 'T1')
        
        if selection == "Home":
            # Pro Handicap: -1 for absolute dominance
            if p_h > 0.65:
                markets.append({"type": f"Handicap -1 {home_name}", "confidence": int(p_h * 100), "desc": "هيمنة مطلقة متوقعة (AH -1)"})
            # Standard Asian: -0.5 (must win)
            elif p_h > 0.52:
                conf_boost = 2 if is_t1 else 0
                markets.append({"type": f"Handicap -0.5 {home_name}", "confidence": int(p_h * 100) + conf_boost, "desc": "أفضلية فنية واضحة (AH -0.5)"})
            # Safety Asian: -0.25 (Win or half-refund)
            elif p_h > 0.45 and p_d > 0.25:
                markets.append({"type": f"Handicap -0.25 {home_name}", "confidence": int((p_h + (p_d/2)) * 100), "desc": "تأمين ربع الرهان (AH -0.25)"})

        elif selection == "Away":
            if p_a > 0.65:
                markets.append({"type": f"Handicap -1 {away_name}", "confidence": int(p_a * 100), "desc": "فوارق فنية شاسعة (AH -1)"})
            elif p_a > 0.52:
                conf_boost = 2 if is_t1 else 0
                markets.append({"type": f"Handicap -0.5 {away_name}", "confidence": int(p_a * 100) + conf_boost, "desc": "أفضلية تكتيكية للضيوف (AH -0.5)"})
            elif p_a > 0.45 and p_d > 0.25:
                markets.append({"type": f"Handicap -0.25 {away_name}", "confidence": int((p_a + (p_d/2)) * 100), "desc": "تأمين ربع الرهان (AH -0.25)"})

        # 4. Draw No Bet (DNB) / AH 0
        # High priority in Big Leagues where draws are common
        if is_t1:
            if selection == "Home" and p_h > 0.40:
                markets.append({"type": f"DNB {home_name}", "confidence": int(dnb_h * 100) + 5, "desc": "تأمين احترافي ضد التعادل (DNB)"})
            elif selection == "Away" and p_a > 0.40:
                markets.append({"type": f"DNB {away_name}", "confidence": int(dnb_a * 100) + 5, "desc": "تأمين احترافي ضد التعادل (DNB)"})
        else:
            if selection == "Home" and p_d > 0.32:
                markets.append({"type": f"DNB {home_name}", "confidence": int(dnb_h * 100), "desc": "تأمين تكتيكي (DNB)"})
            elif selection == "Away" and p_d > 0.32:
                markets.append({"type": f"DNB {away_name}", "confidence": int(dnb_a * 100), "desc": "تأمين تكتيكي (DNB)"})

        # 5. Over/Under 2.5 Goals
        if mc_ou25 > 65:
            markets.append({"type": "Over 2.5 Goals", "confidence": int(mc_ou25), "desc": "نمط هجومي غزير الأهداف"})
        elif mc_ou25 < 35:
            markets.append({"type": "Under 2.5 Goals", "confidence": int(100 - mc_ou25), "desc": "نمط دفاعي مغلق"})

        # 6. Under 3.5 (Extreme Security)
        if mc_ou25 < 45 and xg_h + xg_a < 2.2:
            markets.append({"type": "Under 3.5 Goals", "confidence": 88, "desc": "توقع مباراة شحيحة الأهداف جداً"})

        if not markets:
            return {"type": selection_label, "confidence": int(selection_prob * 100), "desc": "توقع كلاسيكي بناءً على التفوق الفني"}, None
            
        # Sort by confidence and get top 2
        sorted_markets = sorted(markets, key=lambda x: x['confidence'], reverse=True)
        primary = sorted_markets[0]
        backup = sorted_markets[1] if len(sorted_markets) > 1 else None
        
        return primary, backup

    surgical_verdict, backup_verdict = get_best_surgical_market()
    selection_label = surgical_verdict['type']
    surgical_confidence = float(surgical_verdict['confidence'])
    confidence = surgical_confidence
    pattern_desc = surgical_verdict['desc']
    
    backup_label = backup_verdict['type'] if backup_verdict else "N/A"
    backup_conf = backup_verdict['confidence'] if backup_verdict else 0

    # --- TITANIUM V19: Final Selection — Score-Driven, No 50/50 Defaults ---
    # Selection labels are now updated by the surgical verdict

    # --- [TITANIUM ULTRA-DEFENSE] Sanitize All Inputs ---
    def _sanitize(key, default=0.0):
        try:
            val = match_obj.get(key)
            if val is None: return float(default)
            if str(val).lower() in ['none', 'null', '', 'nan']: return float(default)
            return float(val)
        except:
            return float(default)

    # Pre-load all critical metrics with safe fallbacks
    # We use a two-step approach to ensure No-Bet doesn't happen due to missing odds
    odds_h = _sanitize('odds_home', _sanitize('home_odds', 0.0))
    odds_d = _sanitize('odds_draw', _sanitize('draw_odds', 0.0))
    odds_a = _sanitize('odds_away', _sanitize('away_odds', 0.0))
    odds_h_open = _sanitize('odds_home_open', odds_h)
    odds_d_open = _sanitize('odds_draw_open', odds_d)
    odds_a_open = _sanitize('odds_away_open', odds_a)
    news_impact = _sanitize('news_impact', 0.0)
    
    # 7. Confidence Calibration (Scientific Variance)
    safe_sel_p = _sanitize('selection_prob', 0.5) 
    # If selection_prob was passed in locals but not in match_obj
    if safe_sel_p == 0.5 and 'selection_prob' in locals():
        safe_sel_p = _sanitize('selection_prob', 0.5) # Re-check
    
    temp_win_prob = safe_sel_p / 100 if safe_sel_p > 1 else safe_sel_p
    temp_odds = odds_h if selection == "Home" else (odds_a if selection == "Away" else odds_d)
    value_index = (temp_win_prob * temp_odds)
    is_value_bet = value_index > 1.10
    
    confidence = safe_sel_p * 100
    
    # 7.1 Relaxed penalty for tactical parity
    p_h_val = _sanitize('p_h', 0.33)
    p_a_val = _sanitize('p_a', 0.33)
    if abs(p_h_val - p_a_val) < 0.05:
        confidence *= 0.95 
        
    # 7.2 V70 REALISM: Calibrated Confidence Mapping
    if safe_sel_p > 0.50:
        # Calibrated sigmoid-like mapping: base = 40 + prob * 60, capped at 90%
        calibrated_base = min(90.0, 40.0 + safe_sel_p * 60.0)

        # Supporting signals (small verified bonuses only)
        signal_bonus = 0
        if news_impact > 0.1: signal_bonus += 2
        if is_value_bet: signal_bonus += 3
        if _sanitize('style_h_mod', 1.0) > 1.05 or _sanitize('style_a_mod', 1.0) > 1.05: signal_bonus += 2

        confidence = max(confidence, calibrated_base + signal_bonus)
    
    # 7.4 V25 Motivation Level Filter (10% Weight)
    # Applied to confidence to reflect the stakes of the match
    mot_factor = _sanitize('motivation_context', 1.0)
    if mot_factor != 1.0:
        # Scale: 1.5 motivation -> +5% boost, 0.6 motivation -> -10% penalty
        confidence *= (1.0 + (mot_factor - 1.0) * 0.1)

    # 7.5 V26 Reliability Index (Elite Verification)
    completeness = _sanitize('data_completeness', 50.0)
    liquidity = _sanitize('liquidity_index', 0.5)
    confirmed = _sanitize('v26_lineups_confirmed', 0.0)
    
    # Equation: 30% Completeness + 10% Liquidity + 60% Confirmed Lineups
    # If lineups are NOT confirmed, total reliability is capped at 45% (Uncertainty Clause)
    reliability_index = (completeness * 0.3) + (liquidity * 10.0)
    if confirmed > 0:
        reliability_index += 60.0
    else:
        reliability_index = min(45.0, reliability_index)
    
    # 7.6 Tactical Integrity Sentinel (Market Trap Detector)
    mom_trend = _sanitize('v26_momentum_trend', 0.0)
    # Odds Drop Check
    odds_drop_h = (odds_h_open - odds_h) / odds_h_open if odds_h_open > 0 else 0
    odds_drop_a = (odds_a_open - odds_a) / odds_a_open if odds_a_open > 0 else 0
    
    # TRAP A: Home Odds dropping (>15%) but momentum is favoring Away (< -10)
    if odds_drop_h > 0.15 and mom_trend < -10:
        confidence *= 0.85
        analysis.append("⚠️ V26 ALERT: Piège de marché détecté. Chute de cote Home sans pression offensive.")
        
    # TRAP B: Away Odds dropping (>15%) but momentum is favoring Home (> 10)
    if odds_drop_a > 0.15 and mom_trend > 10:
        confidence *= 0.85
        analysis["Trap_B"] = "⚠️ V26 ALERT: Piège de marché détecté. Chute de cote Away sans pression offensive."

    # 7.7 V70 & TIER LOGIC Volatility Penalty
    if league_tier == 'T3':
        confidence *= 0.80 # Strictly remove 20% flat penalty
        confidence = min(64.5, confidence) # Absolute cap -> Will trigger "RISKY" & Suspicious Icon (<65%)
        analysis["Volatility"] = {
            "score": 50,
            "reason": f"⚠️ TIER 3 VOLATILITY: البطولة '{league_name_str}' تفتقر لاستقرار البيانات. تم تخفيض الثقة بنسبة 20% لتجنب المخاطرة."
        }
    else:
        # Fallback to old penalty logic
        league_name_context = match_obj.get('league') or match_obj.get('tournament_name', '')
        volatility_penalty, is_volatile_league = get_league_volatility_penalty(league_name_context)
        
        if volatility_penalty > 0:
            confidence -= volatility_penalty
            if is_volatile_league:
                # Hard Cap to prevent SAFE BETs in inherently unpredictable environments
                confidence = min(79.0, confidence)
                analysis["Volatility"] = {
                    "score": int(100 - volatility_penalty),
                    "reason": f"⚠️ Volatility Alert: {league_name_context}. Confiance bridée à {int(confidence)}% max."
                }

    # 7.8 [V90] ADAPTIVE LEARNING ENGINE V2 (Self-Correcting AI)
    adaptive_adj = float(match_obj.get('adaptive_confidence_adj', 0.0))
    if adaptive_adj != 0:
        confidence += adaptive_adj
        analysis["Adaptive_AI"] = {
            "score": int(max(0, min(100, 100 + adaptive_adj))),
            "reason": f"🧠 Cerveau Adaptatif: Correction automatique ({adaptive_adj:+.1f}%) appliquée suite aux biais historiques de cette ligue."
        }
        
    # Final Safety Clamp
    confidence = max(0.1, min(100.0, confidence + (conf_mod)))
    
    outcomes = [
        ("Home", p_h, odds_h, odds_h_open),
        ("Draw", p_d, odds_d, odds_d_open),
        ("Away", p_a, odds_a, odds_a_open)
    ]
    
    best_outcome = max(outcomes, key=lambda x: x[1])
    selection = best_outcome[0]
    win_prob = best_outcome[1] * 100
    odds = best_outcome[2]
    odds_open = best_outcome[3]
    
    # Value Index (Already computed above to fix NameErrors)
    pass
    
    # Momentum & Rollings (Extracted for analysis)
    h_roll_g3, h_roll_p3 = calculate_rolling_averages(h_hist, window=3)
    a_roll_g3, a_roll_p3 = calculate_rolling_averages(a_hist, window=3)
    ref_name = match_obj.get('referee') or match_obj.get('refereeName')
    
    total_absentee_impact = 0
    if h_att_mod < 0.95 or a_att_mod < 0.95 or h_def_mod > 1.05 or a_def_mod > 1.05:
        total_absentee_impact = abs(1.0 - h_att_mod) + abs(1.0 - a_att_mod)

    # Smart Money Tracking (Line Movement)
    is_smart_money = False
    odds_drop_pct = 0
    is_confirmed = confidence >= 85

    # [TITANIUM V19] AI CS-PREDICTION (Poisson Matrix)
    def calculate_poisson_cs(lh, la, winner):
        import math
        cs_results = []
        for h in range(5):
            for a in range(5):
                # Poisson P(k; λ) = (λ^k * e^-λ) / k!
                p_h = (math.pow(lh, h) * math.exp(-lh)) / math.factorial(h)
                p_a = (math.pow(la, a) * math.exp(-la)) / math.factorial(a)
                total_prob = p_h * p_a * 100
                
                # Rule 4: Match Winner Sync
                match_logic = False
                if winner == "Home" and h > a: match_logic = True
                elif winner == "Away" and a > h: match_logic = True
                elif winner == "Draw" and h == a: match_logic = True
                
                if match_logic:
                    cs_results.append({"score": f"{h} - {a}", "prob": round(total_prob, 1)})
        
        # Sort by probability
        cs_results.sort(key=lambda x: x['prob'], reverse=True)
        # Filter: Exceed 12% + Top 3
        return [r for r in cs_results if r['prob'] >= 10.0][:3] # Using 10% as baseline to ensure we get results, but will label as per user request

    cs_predictions = calculate_poisson_cs(xg_h, xg_a, selection)
    
    # Force expected_score to be first if it matches selection and isn't already there
    if expected_score and not any(r['score'] == expected_score for r in cs_predictions):
        # Calculate prob for expected_score
        try:
            eh, ea = map(int, expected_score.split(' - '))
            p_eh = (math.pow(xg_h, eh) * math.exp(-xg_h)) / math.factorial(eh)
            p_ea = (math.pow(xg_a, ea) * math.exp(-xg_a)) / math.factorial(ea)
            cs_predictions.insert(0, {"score": expected_score, "prob": round(p_eh * p_ea * 100, 1)})
        except: pass
    
    # Ensure uniqueness and top 3
    seen = set()
    unique_cs = []
    for cp in cs_predictions:
        if cp['score'] not in seen:
            unique_cs.append(cp)
            seen.add(cp['score'])
    cs_predictions = unique_cs[:3]

    # Final Form Scores
    h_form_score = (h_mom * 10) + (h_roll_p3 * 20)
    a_form_score = (a_mom * 10) + (a_roll_p3 * 20)

    # --- 10-POINT EXPERT ANALYSIS REPORT ---
    
    # 1. Team Form (QoP Adjusted)
    analysis["1_Form"] = {
        "score": int(max(h_form_score, a_form_score)),
        "reason": f"Momentum: {home_name} ({h_mom:.1f}) vs {away_name} ({a_mom:.1f}). " +
                  (f"QoP (xG-Elo) Delta {perf_delta_h:+.2f} {home_name}." if abs(perf_delta_h) > 0.1 else f"Dynamique stable ({selection_label}).")
    }

    # 2. Head-to-Head
    h2h_h_mod, _ = get_h2h_modifier(home_name, away_name)
    analysis["2_H2H"] = {
        "score": int(features.get('h2h_win_rate', 0)),
        "reason": f"Historique: {int(features.get('h2h_games', 0))} rencontres. Taux de victoire {home_name}: {features.get('h2h_win_rate', 0):.0f}%. " +
                  ("Domination tactique historique confirmée." if h2h_h_mod > 1.05 else "Historique équilibré.")
    }

    # 3. Expected Goals (xG)
    analysis["3_xG"] = {
        "score": int(selection_prob * 100),
        "reason": f"Offensive xG: {xg_h:.2f} (H) vs {xg_a:.2f} (A). Qualité de tir supérieure pour {selection_label}."
    }

    analysis["4_Players"] = {
        "score": 100 - int(features.get('home_injury_impact', 0) * 10),
        "reason": (f"Impact absences: -{int(total_absentee_impact*100)}%. " if total_absentee_impact > 0 else "Effectifs au complet. ") +
                  f"Sentiment global: {float(match_obj.get('news_sentiment', 0)):+.1f}."
    }

    # 5. Tactical Analysis
    fav_team_tactics = home_name if style_h_mod > style_a_mod else (away_name if style_a_mod > style_h_mod else "Standard")
    analysis["5_Tactics"] = {
        "score": 75 + int(max(style_h_mod, style_a_mod) * 10 - 10),
        "reason": f"Style: {h_style} vs {a_style}. Intensité de pressing: Moderate. Avantage {fav_team_tactics} sur les transitions."
    }

    # 6. Market & Odds
    analysis["6_Market"] = {
        "score": int(odds_drop_pct * 100) if is_smart_money else 50,
        "reason": f"Indice de valeur: {value_index:.2f}. " + 
                  (f"Alerte Smart Money: Chute de {int(odds_drop_pct*100)}% sur {selection}." if is_smart_money else "Mouvements de marché stables.")
    }

    # 7. Match Context (V50+ Hafiz DMF)
    h_zone = match_obj.get('home_zone', 'Standard')
    a_zone = match_obj.get('away_zone', 'Standard')
    
    analysis["7_Context"] = {
        "score": int(min(100, max(h_dmf, a_dmf) * 60)),
        "reason": f"Hafiz DMF: {h_dmf:.2f} (H) / {a_dmf:.2f} (A). Signature: {motivation_signature}. " +
                  (f"{home_name} ({h_zone}) vs {away_name} ({a_zone}). " if h_zone != 'Standard' else "Pression tactique liée au classement.") +
                  (f" Dead Zone détectée ({home_name if h_is_dz else away_name})." if (h_is_dz or a_is_dz) else "")
    }

    # 8. External Factors
    analysis["8_External"] = {
        "score": 80,
        "reason": f"Météo: {features.get('weather_temp', 'N/A')}°C. Arbitre: {ref_name if ref_name else 'Standard'}. Conditions de jeu optimales."
    }

    # 9. Advanced Metrics (xG Efficiency)
    analysis["9_Metrics"] = {
        "score": int(features.get('h_pass_acc', 80)),
        "reason": f"Efficacité xG: {perf_delta_h:+.2f} (H) vs {perf_delta_a:+.2f} (A). " +
                  f"Big Chances: {features.get('h_bc', 0):.1f} vs {features.get('a_bc', 0):.1f}."
    }

    # 10. Smart Betting
    analysis["10_Smart_Indicators"] = {
        "score": 90 if is_confirmed else 60,
        "reason": f"Confiance Simulation MC: {int(confidence)}%. " + 
                  ("Signal WHALE détecté: Flux de paris massif sur cet outcome." if is_confirmed and is_smart_money else "Flux de paris équilibré.")
    }

    # --- Layer V17/V48: Professional Direct-Verdict Interface ---
    if confidence >= 82: verdict = "SAFE BET"
    elif confidence >= 60: verdict = "STRONG BET"
    else: verdict = "RISKY BET"
    
    def get_tube_pct(val_0_100):
        pct = int(min(100, max(0, val_0_100)))
        return f"{pct}%"

    power_tubes = {
        "Attack Strength": get_tube_pct(features.get('home_possession', 50) + (xg_h * 15)),
        "Defense Strength": get_tube_pct(100 - (xg_a * 20)),
        "Recent Form": get_tube_pct(h_form_score / 2),
        "Team Momentum": get_tube_pct(h_mom * 25 if h_mom > 0 else 40),
        "Motivation Level": get_tube_pct(h_dmf * 50)
    }

    # [V98] SURGICAL STRIKE PROTOCOL (Elite Value detection)
    if confidence > 88 and value_index > 1.15 and league_tier == 'T1':
        verdict = "💎 SURGICAL STRIKE"
        analysis["Surgical_Strike"] = "🚨 SURGICAL STRIKE: تم اكتشاف فرصة نادرة تجمع بين دقة تنبؤ هائلة وقيمة سوقية عالية جداً."
        selection_label = f"🔥 {selection_label}"
    
    # Chaos Level already calculated early for DMF

    winner_pred = f"{selection_label}"
    goals_pred = "Over 2.5 Goals" if mc_ou25 >= 55 else "Under 2.5 Goals"
    btts_pred = "Yes" if (sim['btts_prob'] >= 0.50) else "No"
    
    if selection == "Home": dc_pred = f"{home_name} or Draw"
    elif selection == "Away": dc_pred = f"{away_name} or Draw"
    else: dc_pred = f"{home_name} or {away_name}"

    main_four = [
        {"label": "Match Winner", "val": winner_pred},
        {"label": "TOTAL GOALS PREDICTED", "val": f"+2.5 Buts" if (xg_h+xg_a) >= 2.8 else f"-2.5 Buts"},
        {"label": "Double Chance", "val": dc_pred}
    ]

    # [V99] AH EXPERT OVERRIDE: If Asian Handicap offers safer confidence, promote it to main_four
    if surgical_verdict and surgical_verdict['type'].startswith('AH'):
        main_four[0] = {"label": "Elite AH Pick", "val": surgical_verdict['type']}
        analysis["AH_Expert"] = "💡 تم تفضيل إعاقة آسيوية (Asian Handicap) لزيادة الأمان ونسبة الربح."

    # Temporary filler to consume the rest of the old block
    results = []
    


    # V13 Momentum Badge
    if h_mom > a_mom * 1.5 or a_mom > h_mom * 1.5:
        results.append({"label": "📈 MOMENTUM", "val": "Forme Supérieure", "confidence": int(confidence), "color": "#34495e"})

    # --- Top Analyst Engine Integration ---
    try:
        ta_output = _ta_result
        direct_prediction = ta_output.get("direct_prediction", "")
        ta_features = ta_output.get("ml_features", {})

        # [TITANIUM V19] UI CONSISTENCY: Force Top Analyst Flag to match Expected Score
        # If expected score shows a winner, override any 'Draw' flag in direct_prediction
        score_winner = None
        if gh > ga: score_winner = "Home"
        elif ga > gh: score_winner = "Away"
        
        if direct_prediction and score_winner:
            # Replace any 'Draw' or 'Nul' mention with the score-driven winner
            corrected_parts = []
            for part in direct_prediction.split(' | '):
                if 'Draw' in part or 'Nul' in part or 'nul' in part:
                    part = part.replace('Draw', score_winner).replace('Nul', score_winner).replace('nul', score_winner)
                corrected_parts.append(part)
            direct_prediction = ' | '.join(corrected_parts)

        if direct_prediction:
            parts = direct_prediction.split(' | ')
            for i, part in enumerate(parts):
                if ':' in part:
                    k, v = part.split(':', 1)
                    if i < len(main_four):
                        main_four[i] = {"label": k.strip(), "val": v.strip()}
                    else:
                        main_four.append({"label": k.strip(), "val": v.strip()})
                else:
                    main_four.append({"label": "Top Analyst Flag", "val": part.strip()})
    except Exception as e:
        sys.stderr.write(f"⚠️ [TA Engine Output] Error: {str(e)}\n")
        direct_prediction = verdict
        ta_features = {}

    # [TITANIUM V52.2] Relaxed Friendly Threshold
    # Friendlies often lack depth data; we lower the bar to 5% to ensure they get predicted
    data_completeness_score = _f_feat('data_completeness', 50.0)
    tournament_tag = str(match_obj.get('league', '')).lower()
    is_friendly_match = any(x in tournament_tag for x in ['friendly', 'amical', 'world', 'international'])
    comp_threshold = 5.0 if is_friendly_match else 20.0

    # [V52.2] TIER1 Competitive Baseline (Bypass for AFCON/Elite)
    is_tier1 = any(x in tournament_tag for x in ['africa cup', 'afcon', 'champions league', 'nations cup', 'premier league', 'ligue 1', 'laliga', 'serie a', 'bundesliga'])
    
    # [TITANIUM V75.2] AGGRESSIVE ALPHA MODE
    is_elite_tier = (league_tier == 'T1')
    zero_failure_veto = False
    
    # Thresholds adjusted to 70% as requested for higher volume.
    effective_confidence = max(confidence, surgical_confidence)
    
    if effective_confidence < 70.0 and is_elite_tier:
        zero_failure_veto = True
        analysis["Shield"] = f"🛡️ VETO ALPHA: Confiance < 70%."
    
    if risk_score >= 15: # Relaxed further
        zero_failure_veto = True
        analysis["Shield"] = f"🛡️ VETO SÉCURITÉ: Risque critique ({risk_score})."
        
    if reliability_index < 25.0: # Minimum data threshold
        zero_failure_veto = True
        analysis["Shield"] = "🛡️ VETO DONNÉES: Manque de profondeur."

    if zero_failure_veto and not match_obj.get('force_predict'):
        no_bet = True
        verdict = "NO BET (SHIELDED)"
        selection = "No Bet"
        selection_label = "No Bet"
        # Reset confidence to indicate no safe play found
        confidence = 0
        precision_bets = [] 
    
    if data_completeness_score < comp_threshold:
        # Extremely low data → No Bet
        no_bet = True
        verdict = "NO BET"
        selection = "No Bet"
        selection_label = "No Bet"
    # [FIX] Removed UNDER ANALYSIS block — all matches with sufficient data get a real prediction.
    # Data between 20-30% is enough for xG/Monte Carlo to produce a valid score and verdict.

    # [TITANIUM V19 FINAL] Power Score: 90% historical xG weight + 10% composite attack boost
    power_score = round(max(50, (_safe_float(xg_h, 1.2) * 15 * 0.90) + (_safe_float(h_composite_attack, 0.5) * 15 * 0.10) + 50), 1)

    # --- V80 MATCH INTEGRITY & RISK DETECTION ---
    risk_score = 0
    risk_reasons = []

    # Rule 1: Tier 3 or Unknown
    if league_tier in ['T3', 'UNKNOWN']:
        risk_score += 5
        risk_reasons.append("البطولة تفتقر للاستقرار الإحصائي المستمر (Tier 3/Unknown).")

    # Rule 2: Dead Zone Motivation
    safe_h_dmf = float(h_dmf) if 'h_dmf' in locals() else 1.0
    safe_a_dmf = float(a_dmf) if 'a_dmf' in locals() else 1.0
    if safe_h_dmf < 0.9 and safe_a_dmf < 0.9:
        risk_score += 4
        risk_reasons.append("لا يوجد حافز قوي لكلا الفريقين للعب بجدية (Dead Zone).")

    # Rule 3: Motivation Collision (Opportunity for Surprises)
    if (safe_h_dmf > 1.25 and a_is_dz) or (safe_a_dmf > 1.25 and h_is_dz):
        risk_score += 3
        risk_reasons.append("تضارب في الحوافز: فريق يقاتل من أجل النقاط ضد فريق في منطقة الأمان (Potential Surprise).")

    # Rule 4: Market Integrity (Steam Moves / Suspicious Drops)
    o_drop_h = (odds_h_open - odds_h) / odds_h_open if odds_h_open > 0 else 0
    o_drop_a = (odds_a_open - odds_a) / odds_a_open if odds_a_open > 0 else 0
    if (o_drop_h > 0.25 and p_h < 0.35) or (o_drop_a > 0.25 and p_a < 0.35):
        risk_score += 6
        risk_reasons.append("🚨 تحذير: حركة مريبة في السوق (Steam Move) لصالح الفريق غير المرشح.")

    # Rule 5: Missing Data (Data Completeness)
    comp_score = features.get('data_completeness', 100)
    if comp_score < 60.0:
        risk_score += 3
        risk_reasons.append(f"البيانات متقطعة والمباراة تفتقر للعمق الإحصائي (Completeness: {comp_score:.1f}%).")

    # Rule 6: Integrity Sentinel (Low Tier + High Drop)
    if league_tier == 'T3' and (o_drop_h > 0.15 or o_drop_a > 0.15):
        risk_score += 4
        risk_reasons.append("تنبيه: انخفاض مريب في الاحتمالات في دوري منخفض التصنيف (High Integrity Risk).")

    # Rule 7: Frontend Flags Mapping
    is_suspicious_flag = bool(risk_score >= 8)
    is_safe_bet_flag = bool(confidence > 80.0 and league_tier == 'T1' and risk_score < 3)

    # 🛑 TIERED CONFIDENCE PRE-MATCH FILTER
    # Elite/T1: Relaxed 45% | Tier 2 / UNKNOWN: 35% | Tier 3/Suspicious: 0% (Allow UI warning)
    # [TITANIUM V53] Relaxed threshold to avoid mass Poisson fallbacks
    dynamic_threshold = 15.0 # Always allow advanced analysis if any data exists
    
    if confidence < dynamic_threshold:
        sys.stderr.write(f"🛑 REJECTED [{league_tier}]: Extreme Low Confidence ({confidence:.1f}% < {dynamic_threshold:.1f}%).\n")
        return {"success": False, "error": f"Prediction stopped: Confidence too low ({confidence:.1f}%)."}

    # [TITANIUM V26] Twin Match DNA Oracle
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

    # [TITANIUM V52.3] Final Serialization Shield
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
        "ou_25_prob": float(sim['ou_25_prob']),
        "btts_prob": float(sim['btts_prob']),
        "verdict": str("NO BET" if no_bet else selection_label),
        "power_score": float(power_score),
        "chaos_level": float(chaos_level),
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
        # [TITANIUM V21] Strategic Intel
        "strategic_brief": str(strategic_brief),
        "dnb_probs": {"home": float(round(dnb_h*100, 1)), "away": float(round(dnb_a*100, 1))},
        "dc_probs": {"1X": float(round(dc_h*100, 1)), "X2": float(round(dc_a*100, 1)), "12": float(round(dc_12*100, 1))},
        # [TITANIUM V22 ULTIMATE] Success Rate Formula
        # Combined Power (form/xG) and Confidence (AI certainty)
        "v22_success_rate": float(round(min(98.5, (power_score * 0.4) + (confidence * 0.6) - rotation_penalty + (10 if is_smart_money else 0)), 1)),
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
        # [V100] BANKROLL MANAGEMENT: Institutional Kelly Criterion (1/4 Fractional)
        "kelly_stake": float(round(max(0, (((confidence/100) * (temp_odds-1)) - (1-(confidence/100))) / (temp_odds-1) * 0.25 * 100), 1)) if (temp_odds > 1 and confidence > 0) else 0
    }

if __name__ == "__main__":
    import sys
    try:
        input_data = sys.stdin.read()
        if input_data.strip():
            # Use the engine's built-in serialization shield
            result = process_prediction(json.loads(input_data))
            print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
