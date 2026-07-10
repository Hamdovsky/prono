"""
data_loader.py - Module 1: Database connections, file I/O, historical lookups
Extracted from prediction_engine.py (lines 103-1397)

Responsibilities:
- SQLite connections (archive + tactical DB)
- ELO ratings loading
- Team strength calculation (venue-aware, exponential decay)
- League lookups (volatility, home advantage, goals multiplier, draw multiplier)
- H2H modifier and dominance detection
- Twin match oracle
- Historical patterns (Time Machine)
- Gap learning (accuracy log refinement)
- Advanced xG adjustment (weighted historical + ELO + H2H)
"""

import json
import os
import sqlite3
import math

# --- Path Constants ---
CORE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(CORE_DIR)

ELO_PATH = os.path.join(PROJECT_DIR, 'data', 'elo_ratings.json')
DB_ARCHIVE_PATH = os.path.join(PROJECT_DIR, 'data', 'historical_archive.sqlite')
TACTICAL_DB_PATH = os.path.join(PROJECT_DIR, 'data', 'tactical.db')
ACCURACY_LOG_PATH = os.path.join(PROJECT_DIR, 'data', 'accuracy_log.json')

from pg_connector import using_postgres, get_pg_connection, query as pg_query

# --- Global State ---
_ELO_DATA = None
_DB_CONN = None
_TACTICAL_CONN = None
_LEAGUE_DRAW_CACHE = {}
_TEAM_STRENGTH_CACHE = {}
_LEAGUE_HA_CACHE = {}


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def safe_float(val, default=0.0):
    """Safe float conversion with null/NaN handling."""
    try:
        if val is None or str(val).lower() in ['none', 'null', '', 'nan']:
            return 0.0 if default is None else float(default)
        return float(val)
    except Exception:
        return 0.0 if default is None else float(default)


def f_feat(key, source, default=0.0):
    """Safe feature extraction from dict or object attribute."""
    if source is None:
        return float(default)
    try:
        if isinstance(source, dict):
            val = source.get(key)
        else:
            val = getattr(source, key, default)
        return safe_float(val, default)
    except Exception:
        return float(default)


# ============================================================================
# ELO RATINGS
# ============================================================================

def load_elo_ratings():
    """Load ELO ratings from JSON file. Cached after first call."""
    global _ELO_DATA
    if _ELO_DATA is not None:
        return _ELO_DATA
    if os.path.exists(ELO_PATH):
        try:
            with open(ELO_PATH, 'r', encoding='utf-8') as f:
                _ELO_DATA = json.load(f)
                return _ELO_DATA
        except Exception:
            pass
    _ELO_DATA = {}
    return _ELO_DATA


def get_elo_data():
    """Get ELO data (lazy-loaded singleton)."""
    return load_elo_ratings()


# ============================================================================
# DATABASE CONNECTIONS
# ============================================================================

def get_db_connection():
    """Get or create persistent SQLite/PostgreSQL connection to archive DB."""
    global _DB_CONN
    
    # Use Neon PostgreSQL if DATABASE_URL is set
    if using_postgres():
        pg_conn = get_pg_connection()
        if pg_conn:
            return pg_conn
    
    # Fallback to local SQLite
    if _DB_CONN is None:
        try:
            _DB_CONN = sqlite3.connect(DB_ARCHIVE_PATH, check_same_thread=False)
            _DB_CONN.row_factory = sqlite3.Row
        except Exception:
            return None
    return _DB_CONN


def get_tactical_connection():
    """Get or create persistent SQLite connection to tactical DB."""
    global _TACTICAL_CONN
    if _TACTICAL_CONN is None:
        try:
            _TACTICAL_CONN = sqlite3.connect(TACTICAL_DB_PATH, check_same_thread=False)
            _TACTICAL_CONN.row_factory = sqlite3.Row
        except Exception:
            return None
    return _TACTICAL_CONN


# ============================================================================
# TEAM STRENGTH
# ============================================================================

def calculate_team_strength(team_name, venue='overall'):
    """
    Venue-aware team strength using exponential decay weighting.
    venue: 'home', 'away', or 'overall'
    Returns: (avg_scored, avg_conceded)
    """
    try:
        cache_key = f"{team_name}_{venue}"
        if cache_key in _TEAM_STRENGTH_CACHE:
            return _TEAM_STRENGTH_CACHE[cache_key]

        conn = get_db_connection()
        if not conn:
            return 1.0, 1.0

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
        if not rows:
            return 1.2, 1.2

        scored_w = 0.0
        conceded_w = 0.0
        total_w = 0.0
        ALPHA = 0.75

        for i, row in enumerate(rows):
            w = ALPHA ** i
            total_w += w
            if venue == 'overall':
                is_home = row['homeTeam'] == team_name
                s = row['scoreHome'] if is_home else row['scoreAway']
                c = row['scoreAway'] if is_home else row['scoreHome']
                goal_mult = 1.0 if is_home else 1.1
                concede_mult = 1.1 if is_home else 1.0
            else:
                s = row[score_for]
                c = row[score_against]
                goal_mult = 1.0
                concede_mult = 1.0

            scored_w += safe_float(s) * w * goal_mult
            conceded_w += safe_float(c) * w * concede_mult

        avg_scored = scored_w / total_w if total_w > 0 else 1.2
        avg_conceded = conceded_w / total_w if total_w > 0 else 1.2
        _TEAM_STRENGTH_CACHE[cache_key] = (avg_scored, avg_conceded)
        return avg_scored, avg_conceded
    except Exception:
        return 1.2, 1.2


# ============================================================================
# LEAGUE LOOKUPS
# ============================================================================

def get_league_volatility_penalty(league_name):
    """
    Categorizes leagues and returns a confidence penalty and volatility flag.
    Returns: (penalty_percentage, is_volatile)
    """
    if not league_name:
        return 10.0, True

    league = str(league_name).lower()

    elite_leagues = [
        'premier league', 'la liga', 'serie a', 'bundesliga', 'ligue 1',
        'champions league', 'world cup', 'euro',
        'africa cup of nations', 'afcon', 'caf champions league',
        'african nations championship', 'chan',
    ]
    if any(e in league for e in elite_leagues):
        return 0.0, False

    standard_leagues = [
        'championship', 'eredivisie', 'primeira liga', 'mls', 'brasileirao',
        'liga mx', 'europa league', 'super lig', 'pro league', '1st division',
        'serie b', 'segunda'
    ]
    if any(s in league for s in standard_leagues):
        return 5.0, False

    volatile_keywords = [
        'u19', 'u20', 'u21', 'u23', 'women', 'w-league', 'kvinner',
        'nadeshiko', 'state', 'premier league 1', 'premier league 2',
        'premier league 3', 'npl', 'reserve', 'amateur', 'friendly'
    ]
    if any(v in league for v in volatile_keywords):
        return 16.0, True

    return 10.0, True


def get_league_home_advantage(league_name):
    """Calculate real Home Advantage ratio for a specific league from archive data."""
    try:
        if league_name in _LEAGUE_HA_CACHE:
            return _LEAGUE_HA_CACHE[league_name]

        conn = get_db_connection()
        if not conn:
            return 1.15

        query = """
            SELECT AVG(scoreHome) as avg_h, AVG(scoreAway) as avg_a
            FROM archive_matches
            WHERE tournament_name = ? AND scoreHome IS NOT NULL
            ORDER BY id DESC LIMIT 200
        """
        res = conn.execute(query, (league_name,)).fetchone()
        if res and res['avg_h'] and res['avg_a']:
            _LEAGUE_HA_CACHE[league_name] = float(res['avg_h'] / res['avg_a'])
            return _LEAGUE_HA_CACHE[league_name]
    except Exception:
        pass
    return 1.15


def get_league_goals_multiplier(league_name):
    """
    League-specific goal density multiplier.
    Returns 0.86 (low scoring), 1.0 (normal), or 1.12 (high scoring).
    """
    league = str(league_name).lower()

    high_scoring = [
        'bundesliga', 'eredivisie', 'pro league', 'a-league', 'super lig',
        'mls', 'allsvenskan', 'eliteserien', '1. liga', 'bundesliga 2'
    ]
    low_scoring = [
        'ligue 2', 'serie b', 'segunda', 'primeira liga', 'greek', 'egypt',
        'morocco', 'iran', 'south africa', 'argentina', 'colombia', 'romania'
    ]

    if any(x in league for x in high_scoring):
        return 1.12
    if any(x in league for x in low_scoring):
        return 0.86
    return 1.0


def get_league_draw_multiplier(feature_names, base_features, league_name=None):
    """
    League-specific draw boost multiplier from historical data.
    Falls back to safe default of 1.10 if data is unavailable.
    """
    try:
        cache_key = str(league_name) if league_name else 'global'
        if cache_key in _LEAGUE_DRAW_CACHE:
            return _LEAGUE_DRAW_CACHE[cache_key]

        conn = get_db_connection()
        if not conn:
            return 1.0

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
            expected_xgb_rate = max(0.20, real_draw_rate * 0.85)
            mult = min(1.10, real_draw_rate / expected_xgb_rate)
            _LEAGUE_DRAW_CACHE[cache_key] = round(mult, 3)
            return _LEAGUE_DRAW_CACHE[cache_key]
    except Exception:
        pass
    return 1.0


# ============================================================================
# H2H ANALYSIS
# ============================================================================

def get_h2h_modifier(home_name, away_name):
    """Detects 'Bete Noire' effect from last 5 direct encounters."""
    try:
        conn = get_db_connection()
        if not conn:
            return 1.0, 1.0
        query = """
            SELECT homeTeam, awayTeam, scoreHome, scoreAway
            FROM archive_matches
            WHERE ((homeTeam = ? AND awayTeam = ?) OR (homeTeam = ? AND awayTeam = ?))
            AND scoreHome IS NOT NULL
            ORDER BY id DESC LIMIT 5
        """
        rows = conn.execute(query, (home_name, away_name, away_name, home_name)).fetchall()

        if not rows:
            return 1.0, 1.0

        home_points = 0
        total_possible = len(rows) * 3
        for r in rows:
            is_home = (r['homeTeam'] == home_name)
            sh, sa = r['scoreHome'], r['scoreAway']
            if sh == sa:
                home_points += 1
            elif (is_home and sh > sa) or (not is_home and sa > sh):
                home_points += 3

        win_rate = home_points / total_possible
        if win_rate > 0.7:
            return 1.15, 0.85
        if win_rate < 0.3:
            return 0.85, 1.15
    except Exception:
        pass
    return 1.0, 1.0


def calculate_h2h_dominance(h_hist, a_hist, home_name, away_name):
    """Detects psychological dominance (Bete Noire) from team histories."""
    h_wins = 0
    a_wins = 0
    total = 0
    combined = (h_hist or []) + (a_hist or [])
    seen = set()
    for m in combined:
        m_id = m.get('id')
        if m_id in seen:
            continue
        seen.add(m_id)

        m_h = m.get('homeTeam')
        m_a = m.get('awayTeam')
        sh = m.get('homeGoals')
        sa = m.get('awayGoals')

        if sh is None or sa is None:
            continue

        if m_h == home_name and m_a == away_name:
            total += 1
            if sh > sa:
                h_wins += 1
            elif sa > sh:
                a_wins += 1
        elif m_h == away_name and m_a == home_name:
            total += 1
            if sa > sh:
                h_wins += 1
            elif sh > sa:
                a_wins += 1

    if total < 3:
        return 1.0
    h_dominance = h_wins / total
    a_dominance = a_wins / total
    return {"h": h_dominance, "a": a_dominance, "total": total}


# ============================================================================
# TWIN MATCH ORACLE
# ============================================================================

def find_twin_matches(odds_h, odds_d, odds_a, xg_gap):
    """Finds historical matches with similar Odds DNA and xG profiles."""
    try:
        conn = get_db_connection()
        if not conn:
            return None

        odds_tol = 0.25
        query = """
            SELECT scoreHome, scoreAway, tournament_name
            FROM archive_matches
            WHERE oddsHome BETWEEN ? AND ?
              AND oddsDraw BETWEEN ? AND ?
              AND oddsAway BETWEEN ? AND ?
              AND scoreHome IS NOT NULL
            LIMIT 50
        """
        params = (
            odds_h - odds_tol, odds_h + odds_tol,
            odds_d - odds_tol, odds_d + odds_tol,
            odds_a - odds_tol, odds_a + odds_tol
        )

        rows = conn.execute(query, params).fetchall()
        if not rows:
            return None

        results = {"home": 0, "draw": 0, "away": 0, "total": 0, "over25": 0}
        for r in rows:
            sh, sa = r['scoreHome'], r['scoreAway']
            results['total'] += 1
            if sh > sa:
                results['home'] += 1
            elif sh < sa:
                results['away'] += 1
            else:
                results['draw'] += 1
            if (sh + sa) > 2.5:
                results['over25'] += 1

        return results
    except Exception:
        return None


# ============================================================================
# HISTORICAL PATTERNS (TIME MACHINE)
# ============================================================================

def get_historical_patterns(home_team, away_team, match_month):
    """Time Machine Engine: Detects Monthly Curses or Peaks from tactical DB."""
    if not os.path.exists(TACTICAL_DB_PATH):
        return None, None
    try:
        conn = get_tactical_connection()
        if not conn:
            return None, None
        query = "SELECT * FROM historical_patterns WHERE is_active = 1 AND (team_name = ? OR team_name = ?)"
        rows = conn.execute(query, (home_team, away_team)).fetchall()

        home_pattern, away_pattern = None, None
        for r in rows:
            name, ptype = r['team_name'], r['pattern_type']
            is_valid = False
            if ptype.startswith("MONTH_"):
                try:
                    pat_month = int(ptype.split('_')[-1])
                    if pat_month == int(match_month):
                        is_valid = True
                except Exception:
                    pass
            else:
                is_valid = True
            if is_valid:
                if name == home_team:
                    home_pattern = dict(r)
                elif name == away_team:
                    away_pattern = dict(r)
        return home_pattern, away_pattern
    except Exception:
        return None, None


# ============================================================================
# GAP LEARNING
# ============================================================================

def apply_gap_learning_weight(prob_dict, league_name):
    """Refines probabilities based on historical accuracy in this specific league."""
    if not os.path.exists(ACCURACY_LOG_PATH):
        return prob_dict, 0.0
    try:
        with open(ACCURACY_LOG_PATH, 'r', encoding='utf-8') as f:
            log_data = json.load(f)

        league_log = log_data.get(str(league_name), [])
        if not league_log:
            return prob_dict, 0.0

        recent_matches = league_log[-10:]
        failures = sum(1 for m in recent_matches if m.get('vote_was_misleading'))

        if failures >= 2:
            penalty_strength = min(0.25, (failures / 10.0) * 0.5)
            max_key = max(prob_dict, key=prob_dict.get)
            min_key = min(prob_dict, key=prob_dict.get)
            discount = prob_dict[max_key] * penalty_strength
            prob_dict[max_key] -= discount
            prob_dict[min_key] += discount
            return prob_dict, penalty_strength

    except Exception:
        pass
    return prob_dict, 0.0


# ============================================================================
# ADVANCED xG ADJUSTMENT
# ============================================================================

def get_advanced_xg_adjustment(home_name, away_name, league_name, features=None):
    """
    Returns (xg_home, xg_away) based on weighted historical strength
    with dynamic HA, H2H, ELO, and physiological modifiers.
    """
    elo_data = get_elo_data()

    h_scored, h_conceded = calculate_team_strength(home_name)
    a_scored, a_conceded = calculate_team_strength(away_name)

    ha_ratio = get_league_home_advantage(league_name)

    xg_h = (h_scored + a_conceded) / 2 * ha_ratio
    xg_a = (a_scored + h_conceded) / 2 * (1.0 / ha_ratio)

    h2h_h, h2h_a = get_h2h_modifier(home_name, away_name)
    xg_h *= h2h_h
    xg_a *= h2h_a

    if features:
        h_inj = features.get('home_injury_impact', 0)
        a_inj = features.get('away_injury_impact', 0)
        if h_inj >= 3.0:
            xg_h *= 0.85
        elif h_inj > 0:
            xg_h *= 0.95

        if a_inj >= 3.0:
            xg_a *= 0.85
        elif a_inj > 0:
            xg_a *= 0.95

        rest_h = features.get('rest_h', 7.0)
        rest_a = features.get('rest_a', 7.0)
        if rest_h <= 3.0:
            xg_h *= (1.0 - (4.0 - rest_h) * 0.1)
        if rest_a <= 3.0:
            xg_a *= (1.0 - (4.0 - rest_a) * 0.1)

    h_elo = elo_data.get(home_name, 1500)
    a_elo = elo_data.get(away_name, 1500)
    elo_diff = h_elo - a_elo

    xg_h *= (1.0 + elo_diff / 2000.0)
    xg_a *= (1.0 - elo_diff / 2000.0)

    return max(0.4, xg_h), max(0.4, xg_a)


# ─── FREE FALLBACK — DB UPDATE HELPER ──────────────────────────

def update_match_predictions(match_id, predictions):
    """
    Write computed predictions directly into tactical.db.
    Used by free_fallback_service.py to bypass Node.js DB layer.

    predictions dict keys:
        home_win_probability, draw_probability, away_win_probability,
        ou_25_prob, btts_prob, expected_score, prediction,
        confidence, ev_home, home_xg, away_xg
    """
    import time
    try:
        conn = sqlite3.connect(TACTICAL_DB_PATH)
        conn.execute("""
            UPDATE matches SET
                home_win_probability = ?,
                draw_probability = ?,
                away_win_probability = ?,
                ou_25_prob = ?,
                btts_prob = ?,
                expected_score = ?,
                prediction = ?,
                confidence = ?,
                ev_home = ?,
                insufficient_data = 0,
                source = 'free_fallback',
                home_xg = ?,
                away_xg = ?,
                last_updated = ?
            WHERE id = ?
        """, (
            predictions.get('home_win_probability', 33.3),
            predictions.get('draw_probability', 33.3),
            predictions.get('away_win_probability', 33.3),
            predictions.get('ou_25_prob', 50.0),
            predictions.get('btts_prob', 50.0),
            predictions.get('expected_score', '1-1'),
            predictions.get('prediction', 'X'),
            predictions.get('confidence', 50.0),
            predictions.get('ev_home', 0.0),
            predictions.get('home_xg', 1.35),
            predictions.get('away_xg', 1.15),
            int(time.time()),
            match_id
        ))
        conn.commit()
        conn.close()
        return True
    except Exception as e:
        print(f"[DATA_LOADER] Fallback DB update failed for {match_id}: {e}")
        return False
