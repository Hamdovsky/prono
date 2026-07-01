"""
feature_engineer.py - Module 2: Feature extraction, xG calculation, modifiers
Extracted from prediction_engine.py (lines 98-217, 669-776, 973-1243)

Responsibilities:
- V4 feature extraction (stats blob, H2H, DB columns)
- Missing data imputation protocol
- Composite confidence calculation
- Hafiz Dynamic Motivation Factor (DMF)
- xG-Elo Performance Delta (QoP)
- Fatigue modifier
- Composite defense index
- Stylistic clash modifier (playstyle matrix)
- Referee discipline profile
- Tactical intelligence (sterile possession, midfield, enjeu)
"""

import math

from data_loader import safe_float, f_feat


# ============================================================================
# CONSTANTS
# ============================================================================

STATS_KEYS_V4 = [
    'ball_possession', 'expected_goals', 'total_shots', 'shots_on_target',
    'shots_off_target', 'corner_kicks', 'fouls', 'yellow_cards',
    'goalkeeper_saves', 'tackles', 'interceptions', 'clearances',
    'accurate_passes', 'passes', 'shots_inside_box', 'shots_outside_box',
    'ground_duels_won', 'aerial_duels_won', 'big_chances'
]

FEATURE_NAMES_V4 = [
    'h_poss', 'a_poss', 'poss_diff',
    'h_shots', 'a_shots', 'shots_diff',
    'h_sot', 'a_sot', 'sot_diff',
    'h_soff', 'a_soff',
    'h_corners', 'a_corners',
    'h_fouls', 'a_fouls',
    'h_xg', 'a_xg', 'xg_diff',
    'total_shots', 'total_sot', 'total_xg',
    'h_sot_rate', 'a_sot_rate',
    'h_xg_per_shot', 'a_xg_per_shot',
    'h_efficiency', 'a_efficiency',
] + [f"sb_{k}_{s}" for k in STATS_KEYS_V4 for s in ('h', 'a')] + [
    'h2h_home_wins', 'h2h_draws', 'h2h_away_wins', 'h2h_total',
    'h2h_avg_goals', 'h2h_home_rate', 'h2h_draw_rate'
]

STYLISTIC_MATRIX = {
    "Possession": {"Low Block": 0.85, "Counter-Attack": 1.15, "High Press": 1.0, "Balanced": 1.0},
    "Counter-Attack": {"Possession": 1.25, "High Press": 1.20, "Low Block": 0.70, "Balanced": 1.0},
    "High Press": {"Low Block": 1.15, "Possession": 1.10, "Counter-Attack": 0.90, "Balanced": 1.0},
    "Low Block": {"High Press": 0.80, "Counter-Attack": 1.10, "Possession": 1.20, "Balanced": 1.0}
}


# ============================================================================
# V4 FEATURE EXTRACTION
# ============================================================================

def extract_v4_features(match_obj):
    """Extract V4 features from match object (requires match stats)."""
    rd = dict(match_obj)
    feats = {}

    def _f(val, default=0.0):
        try:
            if val is None:
                return float(default)
            if isinstance(val, str):
                s = val.strip()
                if not s or s.lower() in ('none', 'null', 'nan', ''):
                    return float(default)
                return float(s.replace('%', '').split('/')[0])
            return float(val)
        except Exception:
            return float(default)

    def safe_div(a, b):
        return a / b if b and b != 0 else 0.0

    feats['h_poss'] = _f(rd.get('home_possession'))
    feats['a_poss'] = _f(rd.get('away_possession'))
    feats['h_shots'] = _f(rd.get('home_shots'))
    feats['a_shots'] = _f(rd.get('away_shots'))
    feats['h_sot'] = _f(rd.get('home_shots_on_target'))
    feats['a_sot'] = _f(rd.get('away_shots_on_target'))
    feats['h_soff'] = _f(rd.get('home_shots_off'))
    feats['a_soff'] = _f(rd.get('away_shots_off'))
    feats['h_corners'] = _f(rd.get('home_corners'))
    feats['a_corners'] = _f(rd.get('away_corners'))
    feats['h_fouls'] = _f(rd.get('home_fouls'))
    feats['a_fouls'] = _f(rd.get('away_fouls'))
    feats['h_xg'] = _f(rd.get('home_xg'))
    feats['a_xg'] = _f(rd.get('away_xg'))

    feats['poss_diff'] = feats['h_poss'] - feats['a_poss']
    feats['shots_diff'] = feats['h_shots'] - feats['a_shots']
    feats['sot_diff'] = feats['h_sot'] - feats['a_sot']
    feats['xg_diff'] = feats['h_xg'] - feats['a_xg']
    feats['total_shots'] = feats['h_shots'] + feats['a_shots']
    feats['total_sot'] = feats['h_sot'] + feats['a_sot']
    feats['total_xg'] = feats['h_xg'] + feats['a_xg']
    feats['h_sot_rate'] = safe_div(feats['h_sot'], feats['h_shots'])
    feats['a_sot_rate'] = safe_div(feats['a_sot'], feats['a_shots'])
    feats['h_xg_per_shot'] = safe_div(feats['h_xg'], feats['h_shots'])
    feats['a_xg_per_shot'] = safe_div(feats['a_xg'], feats['a_shots'])
    feats['h_efficiency'] = safe_div(_f(rd.get('scoreHome')), feats['h_xg']) if feats['h_xg'] > 0 else 1.0
    feats['a_efficiency'] = safe_div(_f(rd.get('scoreAway')), feats['a_xg']) if feats['a_xg'] > 0 else 1.0

    stats = {}
    sb = rd.get('stats')
    if sb:
        try:
            if isinstance(sb, str):
                data = __import__('json').loads(sb)
            elif isinstance(sb, dict):
                data = sb
            elif isinstance(sb, list):
                for item in sb:
                    if isinstance(item, dict):
                        for k, v in item.items():
                            stats[k] = _f(v)
                data = None
            else:
                data = None

            if isinstance(data, dict):
                for k, v in data.items():
                    stats[k] = _f(v)
        except Exception:
            pass

    for key in STATS_KEYS_V4:
        hk, ak = f"{key}_home", f"{key}_away"
        feats[f"sb_{key}_h"] = stats.get(hk, 0.0)
        feats[f"sb_{key}_a"] = stats.get(ak, 0.0)

    feats['h2h_home_wins'] = 0
    feats['h2h_draws'] = 0
    feats['h2h_away_wins'] = 0
    feats['h2h_total'] = 0
    feats['h2h_avg_goals'] = 0
    h2h_raw = rd.get('h2h_data')
    if h2h_raw:
        try:
            if isinstance(h2h_raw, str):
                h2h = __import__('json').loads(h2h_raw)
            else:
                h2h = h2h_raw
            if isinstance(h2h, dict):
                matches = h2h.get('matches', h2h.get('results', []))
                if isinstance(matches, list) and len(matches) > 0:
                    for m in matches:
                        hs = _f(m.get('homeScore', m.get('scoreHome'), 0))
                        aw = _f(m.get('awayScore', m.get('scoreAway'), 0))
                        if hs > aw:
                            feats['h2h_home_wins'] += 1
                        elif hs == aw:
                            feats['h2h_draws'] += 1
                        else:
                            feats['h2h_away_wins'] += 1
                    feats['h2h_total'] = len(matches)
                    total_goals = sum(
                        _f(m.get('homeScore', m.get('scoreHome'), 0)) + _f(m.get('awayScore', m.get('scoreAway'), 0))
                        for m in matches
                    )
                    feats['h2h_avg_goals'] = safe_div(total_goals, len(matches))
        except Exception:
            pass

    feats['h2h_home_rate'] = safe_div(feats['h2h_home_wins'], max(feats['h2h_total'], 1))
    feats['h2h_draw_rate'] = safe_div(feats['h2h_draws'], max(feats['h2h_total'], 1))

    return feats


# ============================================================================
# MISSING DATA IMPUTATION
# ============================================================================

def impute_missing_match_data(features, match_obj):
    """
    V50+ Imputation Protocol: Ensures zero-crash for missing travel/rest data.
    Extended to robustly handle 115 variables, specifically missing players.
    """
    if features.get('rest_h', 0) <= 0:
        features['rest_h'] = 7.0
    if features.get('rest_a', 0) <= 0:
        features['rest_a'] = 7.0

    if features.get('travel_f', 0) == 0:
        if match_obj.get('is_international') or 'world' in str(match_obj.get('category_name', '')).lower():
            features['travel_f'] = 2.5

    intel_keys = ['news_is_missing_gk', 'news_is_missing_scorer', 'news_is_missing_captain', 'news_is_missing_star']
    for k in intel_keys:
        if features.get(k) is None or str(features.get(k)) == 'nan':
            features[k] = 0.0

    essential = ['h_xg', 'a_xg', 'h_pos', 'a_pos']

    tournament = str(match_obj.get('league', '')).lower() + " " + str(match_obj.get('tournament_name', '')).lower()
    is_friendly = any(x in tournament for x in ['friendly', 'amical', 'club matches', 'friendlies'])

    if is_friendly:
        if features.get('h_xg', 0) <= 0:
            features['h_xg'] = 0.9
        if features.get('a_xg', 0) <= 0:
            features['a_xg'] = 0.9
        if features.get('h_pos', 0) <= 0:
            features['h_pos'] = 50.0
        if features.get('a_pos', 0) <= 0:
            features['a_pos'] = 50.0
        if features.get('h_sot', 0) <= 0:
            features['h_sot'] = 3.0
        if features.get('a_sot', 0) <= 0:
            features['a_sot'] = 3.0

    completeness = sum(1 for f in essential if features.get(f, 0) > 0) / len(essential)
    features['data_completeness'] = completeness * 100

    return features


# ============================================================================
# CONFIDENCE CALCULATION
# ============================================================================

def calculate_composite_confidence(p_xgb, h_dmf, a_dmf, lineups_confirmed, data_completeness=100.0):
    """
    V50+ Composite Confidence Level.
    [TITANIUM V85] Optimized scaling to avoid mid-range clusters.
    """
    clarity_base = abs(p_xgb - 0.33) / 0.67
    clarity = math.pow(clarity_base, 0.7)

    mot_polarity = abs(h_dmf - a_dmf) / 2.0

    lineup_factor = 0.15 if lineups_confirmed else 0.0

    base_boost = 35.0 if clarity > 0.05 else 10.0

    conf = (clarity * 45.0) + (mot_polarity * 20.0) + (lineup_factor * 100.0) + base_boost
    conf_pct = max(10.0, min(98.5, conf))

    if data_completeness < 60.0:
        penalty = ((60.0 - data_completeness) / 60.0) * 20.0
        conf_pct -= penalty

    return max(5.0, min(99.0, conf_pct))


# ============================================================================
# MOTIVATION & FATIGUE
# ============================================================================

def calculate_dmf_hafiz(target_weight, distance_target, matches_rem, matches_played, is_dead_zone=False):
    """
    Hafiz Dynamic Motivation Factor (DMF).
    Quantifies team urgency using an exponential pressure gradient.
    Returns: float between 0.85 (Dead Zone) and ~2.5 (Maximum Urgency).
    """
    if is_dead_zone:
        return 0.85

    gamma = 1.0 + (matches_played / max(1, matches_played + matches_rem)) * 0.5
    pressure = target_weight * math.exp(-0.15 * max(0, distance_target))

    return round(1.0 + (pressure * gamma), 3)


def calculate_xg_perf_delta(history, is_home=True):
    """
    V50+ xG-Elo Layer: Measures 'Quality of Play' (QoP) delta.
    Compares actual results vs expected performance (xG) in last 5 games.
    """
    if not history:
        return 0.0
    recent = history[:5]
    delta_sum = 0.0
    weights = [1.0, 0.8, 0.6, 0.4, 0.2]

    for i, m in enumerate(recent):
        xg_f = safe_float(m.get('h_xg' if is_home else 'a_xg'), 1.0)
        xg_a = safe_float(m.get('a_xg' if is_home else 'h_xg'), 1.0)
        g_f = safe_float(m.get('score_for'), 1.0)
        g_a = safe_float(m.get('score_against'), 1.0)

        qop = (xg_f - xg_a) - (g_f - g_a)
        delta_sum += qop * weights[i]

    return delta_sum / sum(weights[:len(recent)])


def calculate_fatigue_mod(days_rest):
    """Simple fatigue modifier based on rest days."""
    if days_rest is None:
        return 1.0
    if days_rest <= 3:
        return 0.92
    if days_rest >= 7:
        return 1.05
    return 1.0


def calculate_composite_defense(features, is_home=True):
    """
    Calculates a defensive solidity index (0.6 to 1.4).
    Lower is better (tighter defense).
    """
    prefix = 'h_' if is_home else 'a_'
    opp_prefix = 'a_' if is_home else 'h_'

    ga = float(features.get(f'{prefix}ga', 1.2))

    saves = float(features.get(f'{prefix}saves', 3.0))
    save_factor = 1.0 - (min(5, saves) * 0.03)

    tackles = float(features.get(f'{prefix}tackles', 15.0))
    tackle_factor = 1.0 - (min(25, tackles) * 0.01)

    bc_conceded = float(features.get(f'{opp_prefix}bc', 1.5))
    bc_factor = 1.0 + (min(4, bc_conceded) * 0.1)

    base_def = (ga / 1.2) * save_factor * tackle_factor * bc_factor
    return max(0.6, min(1.4, base_def))


# ============================================================================
# STYLISTIC CLASH
# ============================================================================

def get_stylistic_clash_modifier(home_style, away_style, home_momentum=1.0, away_momentum=1.0):
    """V13 Style Matcher + V80 Form Scaling: Adjusts xG based on playstyle interaction."""
    h_mod = STYLISTIC_MATRIX.get(home_style, {}).get(away_style, 1.0)
    a_mod = STYLISTIC_MATRIX.get(away_style, {}).get(home_style, 1.0)

    if h_mod > 1.0 and home_momentum < 0.9:
        h_mod = 1.0 + (h_mod - 1.0) * home_momentum
    elif h_mod < 1.0 and home_momentum > 1.2:
        h_mod = 1.0 - (1.0 - h_mod) * 0.5

    if a_mod > 1.0 and away_momentum < 0.9:
        a_mod = 1.0 + (a_mod - 1.0) * away_momentum
    elif a_mod < 1.0 and away_momentum > 1.2:
        a_mod = 1.0 - (1.0 - a_mod) * 0.5

    return h_mod, a_mod


def get_referee_discipline_profile(ref_name):
    """V13 Discipline Engine: Detects referee strictness."""
    if not ref_name:
        return 1.0
    return 1.2 if "Strict" in str(ref_name) else 1.0


# ============================================================================
# TACTICAL INTELLIGENCE
# ============================================================================

def apply_tactical_intelligence(match_obj, features, xg_h, xg_a):
    """
    TITANIUM TACTICAL V3: Deep analysis of midfield, possession, and motivation.
    Returns: (xg_h_modified, xg_a_modified, tactical_alerts_list)
    """
    tactical_alerts = []
    h_mod, a_mod = 1.0, 1.0

    h_pos = f_feat('h_pos', features, 50.0)
    h_sot = f_feat('h_sot', features, 4.0)
    a_pos = f_feat('a_pos', features, 50.0)
    a_sot = f_feat('a_sot', features, 4.0)

    if h_pos > 58.0 and h_sot < 3.0:
        h_mod *= 0.82
        tactical_alerts.append("POSSESSION STERILE (H): Domination sans danger.")
    if a_pos > 58.0 and a_sot < 3.0:
        a_mod *= 0.82
        tactical_alerts.append("POSSESSION STERILE (A): Domination sans danger.")

    intel_h = match_obj.get('news_data', {}).get('home', {}).get('intelligence', {}) if isinstance(match_obj.get('news_data'), dict) else {}
    intel_a = match_obj.get('news_data', {}).get('away', {}).get('intelligence', {}) if isinstance(match_obj.get('news_data'), dict) else {}

    if intel_h.get('is_missing_midfielder') or match_obj.get('is_missing_midfielder'):
        h_mod *= 0.88
        xg_a *= 1.12
        tactical_alerts.append("RUPTURE DU MILIEU (H): Absence du recupérateur clé.")
    if intel_a.get('is_missing_midfielder') or match_obj.get('is_missing_midfielder_away'):
        a_mod *= 0.88
        xg_h *= 1.12
        tactical_alerts.append("RUPTURE DU MILIEU (A): Absence du recupérateur clé.")

    h_pos_rank = f_feat('home_rank', match_obj, 10)
    a_pos_rank = f_feat('away_rank', match_obj, 10)

    if h_pos_rank <= 4 or h_pos_rank >= 17:
        h_mod *= 1.08
        tactical_alerts.append("ENJEU MAXIMUM (H): Bataille pour l'Europe ou le Maintien.")
    if a_pos_rank <= 4 or a_pos_rank >= 17:
        a_mod *= 1.08
        tactical_alerts.append("ENJEU MAXIMUM (A): Bataille pour l'Europe ou le Maintien.")

    return xg_h * h_mod, xg_a * a_mod, tactical_alerts
