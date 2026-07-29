import json
import sqlite3
import os
import math
import functools

DB_ARCHIVE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'historical_archive.sqlite')
DB_TACTICAL_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'tactical.db')
ELO_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'elo_ratings.json')
STYLES_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'team_styles.json')

from pg_connector import using_postgres, get_pg_connection, query as pg_query, get_league_params

def load_json(path):
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except: return {}
    return {}

ELO_RATINGS = load_json(ELO_PATH)
TEAM_STYLES = load_json(STYLES_PATH)

def _f(v, default=0.0):
    try:
        if v is None or str(v).lower() in ['none', 'null', '', 'nan']: return float(default)
        return float(v)
    except:
        return float(default)

def parse_pct(s):
    return _f(str(s).replace('%', '').strip() if s else 0)

_DB_CONN = None
_WC2026_TEAMS_CACHE = None
_XG_HOME_MODEL = None
_XG_AWAY_MODEL = None
_XG_ARCHIVE_MODEL = None

def get_wc2026_team_data():
    global _WC2026_TEAMS_CACHE
    if _WC2026_TEAMS_CACHE is not None:
        return _WC2026_TEAMS_CACHE
    conn = get_db_connection()
    if conn is None:
        _WC2026_TEAMS_CACHE = {}
        return _WC2026_TEAMS_CACHE
    try:
        rows = conn.execute("SELECT team_name, fifa_rank, fifa_points, total_market_value_eur AS total_market_value, squad_size, average_age, confederation FROM wc2026_teams").fetchall()
        cache = {}
        for r in rows:
            name = str(r['team_name']).strip().lower()
            cache[name] = {
                'fifa_rank': _f(r['fifa_rank'], 999),
                'fifa_points': _f(r['fifa_points'], 0),
                'squad_value': _f(r['total_market_value'], 0),
                'squad_size': _f(r['squad_size'], 26),
                'avg_age': _f(r['average_age'], 27),
                'confederation': str(r['confederation'] or ''),
            }
        _WC2026_TEAMS_CACHE = cache
    except Exception:
        _WC2026_TEAMS_CACHE = {}
    return _WC2026_TEAMS_CACHE

def _load_xg_models():
    global _XG_HOME_MODEL, _XG_AWAY_MODEL, _XG_ARCHIVE_MODEL
    if _XG_HOME_MODEL is not None:
        return
    import xgboost as xgb
    model_dir = os.path.dirname(os.path.dirname(__file__))
    home_path = os.path.join(model_dir, 'models', 'xg_home_model.json')
    away_path = os.path.join(model_dir, 'models', 'xg_away_model.json')
    arch_path = os.path.join(model_dir, 'models', 'xg_archive_model.json')
    if os.path.exists(home_path) and os.path.exists(away_path):
        try:
            _XG_HOME_MODEL = xgb.Booster()
            _XG_HOME_MODEL.load_model(home_path)
            _XG_AWAY_MODEL = xgb.Booster()
            _XG_AWAY_MODEL.load_model(away_path)
        except Exception:
            _XG_HOME_MODEL = _XG_AWAY_MODEL = None
    if os.path.exists(arch_path):
        try:
            _XG_ARCHIVE_MODEL = xgb.Booster()
            _XG_ARCHIVE_MODEL.load_model(arch_path)
        except Exception:
            _XG_ARCHIVE_MODEL = None

def _predict_xg_h(row, ts_h):
    """Predict home xG from match stats when real xG unavailable."""
    try:
        _load_xg_models()
        # Try full model first (needs shots_inside_box)
        if _XG_HOME_MODEL is not None:
            ib = _f(row.get('home_shots_inside_box') or ts_h.get('avgShotsInsideBox'), 0)
            sot = _f(row.get('home_shots_on_goal') or _f(row.get('sot_home')) or ts_h.get('avgShotsOnTarget'), 0)
            ts_ = _f(row.get('home_shots_total') or _f(row.get('shots_home')) or ts_h.get('avgShots'), 0)
            pos = _f(row.get('home_possession') or ts_h.get('avgPossession'), 50.0)
            corn = _f(row.get('home_corners') or _f(row.get('corners_home')) or ts_h.get('avgCorners'), 0)
            if ib > 0 or (sot > 0 and ts_ > 0):
                import numpy as np
                arr = np.array([[ib, sot, ts_, pos, corn]], dtype=np.float32)
                return float(_XG_HOME_MODEL.predict(xgb.DMatrix(arr))[0])
        # Fall back to archive model (total shots, sot, corners, pos)
        if _XG_ARCHIVE_MODEL is not None:
            ts_ = _f(row.get('home_shots_total') or _f(row.get('shots_home')) or ts_h.get('avgShots'), 0)
            sot = _f(row.get('home_shots_on_goal') or _f(row.get('sot_home')) or ts_h.get('avgShotsOnTarget'), 0)
            corn = _f(row.get('home_corners') or _f(row.get('corners_home')) or ts_h.get('avgCorners'), 0)
            pos = _f(row.get('home_possession') or ts_h.get('avgPossession'), 50.0)
            if ts_ > 0 or sot > 0:
                import numpy as np
                sot_rate = sot / (ts_ + 1)
                arr = np.array([[ts_, sot, corn, pos, sot_rate]], dtype=np.float32)
                return float(_XG_ARCHIVE_MODEL.predict(xgb.DMatrix(arr))[0])
        return None
    except Exception:
        return None

def _predict_xg_a(row, ts_a):
    """Predict away xG from match stats when real xG unavailable."""
    try:
        _load_xg_models()
        # Try full model first (needs shots_inside_box)
        if _XG_AWAY_MODEL is not None:
            ib = _f(row.get('away_shots_inside_box') or ts_a.get('avgShotsInsideBox'), 0)
            sot = _f(row.get('away_shots_on_goal') or _f(row.get('sot_away')) or ts_a.get('avgShotsOnTarget'), 0)
            ts_ = _f(row.get('away_shots_total') or _f(row.get('shots_away')) or ts_a.get('avgShots'), 0)
            pos = _f(row.get('away_possession') or ts_a.get('avgPossession'), 50.0)
            corn = _f(row.get('away_corners') or _f(row.get('corners_away')) or ts_a.get('avgCorners'), 0)
            if ib > 0 or (sot > 0 and ts_ > 0):
                import numpy as np
                arr = np.array([[ib, sot, ts_, pos, corn]], dtype=np.float32)
                return float(_XG_AWAY_MODEL.predict(xgb.DMatrix(arr))[0])
        # Fall back to archive model (total shots, sot, corners, pos)
        if _XG_ARCHIVE_MODEL is not None:
            ts_ = _f(row.get('away_shots_total') or _f(row.get('shots_away')) or ts_a.get('avgShots'), 0)
            sot = _f(row.get('away_shots_on_goal') or _f(row.get('sot_away')) or ts_a.get('avgShotsOnTarget'), 0)
            corn = _f(row.get('away_corners') or _f(row.get('corners_away')) or ts_a.get('avgCorners'), 0)
            pos = _f(row.get('away_possession') or ts_a.get('avgPossession'), 50.0)
            if ts_ > 0 or sot > 0:
                import numpy as np
                sot_rate = sot / (ts_ + 1)
                arr = np.array([[ts_, sot, corn, pos, sot_rate]], dtype=np.float32)
                return float(_XG_ARCHIVE_MODEL.predict(xgb.DMatrix(arr))[0])
        return None
    except Exception:
        return None

def get_db_connection():
    """Returns SQLite or PostgreSQL connection based on DATABASE_URL."""
    global _DB_CONN
    
    # Use Neon PostgreSQL if DATABASE_URL is set and starts with postgres
    if using_postgres():
        pg_conn = get_pg_connection()
        if pg_conn:
            return pg_conn
    
    # Fallback to local SQLite
    if not os.path.exists(DB_ARCHIVE_PATH):
        return None
    
    if _DB_CONN is None:
        try:
            _DB_CONN = sqlite3.connect(DB_ARCHIVE_PATH, check_same_thread=False)
            _DB_CONN.row_factory = sqlite3.Row
        except:
            return None
    return _DB_CONN

def close_db_connection():
    global _DB_CONN
    if _DB_CONN:
        try:
            _DB_CONN.close()
        except: pass
        _DB_CONN = None

def extract_features_from_stats(stats_json):
    if not stats_json: return {}
    try:
        stats = json.loads(stats_json)
        features = {}
        if isinstance(stats, list):
            for item in stats:
                if not isinstance(item, dict): continue
                cat = item.get('category', 'Unknown')
                val_h = item.get('homeValue', 0)
                val_a = item.get('awayValue', 0)
                def _clean(val):
                    if isinstance(val, str):
                        try: return float(val.replace('%', '').split('/')[0])
                        except: return 0.0
                    return float(val) if val is not None else 0.0
                features[f"{cat}_home"] = _clean(val_h)
                features[f"{cat}_away"] = _clean(val_a)
        elif isinstance(stats, dict):
            for k, v in stats.items():
                try: features[k] = float(v) if v is not None else 0.0
                except: features[k] = 0.0
        return features
    except: return {}

def _get_team_history_pg(team_name, limit=10, current_match_ts=None):
    """Get team history from Neon PostgreSQL (soccer_fixtures + soccer_match_stats)."""
    try:
        clean_name = team_name.strip().lower()
        import time
        cutoff_ts = int(current_match_ts) if current_match_ts else int(time.time())
        from datetime import datetime
        cutoff_dt = datetime.fromtimestamp(cutoff_ts)
        cutoff_date = cutoff_dt.strftime('%Y-%m-%d')

        # Use soccer_fixtures as primary source (378K finished matches)
        rows = pg_query("""
            SELECT f.goals_home, f.goals_away, f.date, f.home_team, f.away_team,
                   m.home_possession, m.away_possession,
                   m.home_shots, m.away_shots,
                   m.home_shots_on_goal, m.away_shots_on_goal,
                   m.home_corners, m.away_corners,
                   m.home_fouls, m.away_fouls,
                   m.home_yellow_cards, m.away_yellow_cards,
                   m.home_red_cards, m.away_red_cards
            FROM soccer_fixtures f
            LEFT JOIN soccer_match_stats m ON f.id = m.fixture_id
            WHERE (LOWER(f.home_team) = %s OR LOWER(f.away_team) = %s)
            AND f.goals_home IS NOT NULL
            AND (f.date IS NULL OR f.date < %s)
            ORDER BY f.date DESC NULLS LAST
            LIMIT %s
        """, (clean_name, clean_name, cutoff_date, limit + 10))

        history = []
        for r in (rows or []):
            h_team = (r.get('home_team') or '')
            a_team = (r.get('away_team') or '')
            is_home = (h_team.lower() == clean_name)

            norm = {}
            if is_home:
                norm['Ball possession_home'] = float(r.get('home_possession') or 50)
                norm['Total shots_home'] = float(r.get('home_shots') or 0)
                norm['Shots on target_home'] = float(r.get('home_shots_on_goal') or 0)
                norm['Corner kicks_home'] = float(r.get('home_corners') or 0)
                norm['Fouls_home'] = float(r.get('home_fouls') or 0)
                norm['Yellow cards_home'] = float(r.get('home_yellow_cards') or 0)
                norm['Red cards_home'] = float(r.get('home_red_cards') or 0)
            else:
                norm['Ball possession_home'] = float(r.get('away_possession') or 50)
                norm['Total shots_home'] = float(r.get('away_shots') or 0)
                norm['Shots on target_home'] = float(r.get('away_shots_on_goal') or 0)
                norm['Corner kicks_home'] = float(r.get('away_corners') or 0)
                norm['Fouls_home'] = float(r.get('away_fouls') or 0)
                norm['Yellow cards_home'] = float(r.get('away_yellow_cards') or 0)
                norm['Red cards_home'] = float(r.get('away_red_cards') or 0)

            s_for = r.get('goals_home') if is_home else r.get('goals_away')
            s_ag = r.get('goals_away') if is_home else r.get('goals_home')

            norm['score_for'] = float(s_for) if s_for is not None else 0.0
            norm['score_against'] = float(s_ag) if s_ag is not None else 0.0
            norm['opponent_name'] = a_team if is_home else h_team

            if norm['score_for'] > norm['score_against']: norm['points'] = 3.0
            elif norm['score_for'] == norm['score_against']: norm['points'] = 1.0
            else: norm['points'] = 0.0

            history.append(norm)

        return history[:limit]
    except Exception:
        import sys
        sys.stderr.write(f"[PG] get_team_history error: {Exception}\n")
        return []

@functools.lru_cache(maxsize=256)
def get_team_history(team_name, limit=10, current_match_ts=None):
    # Use Neon PostgreSQL first if available
    if using_postgres():
        pg_hist = _get_team_history_pg(team_name, limit, current_match_ts)
        if pg_hist:
            return pg_hist

    conn = get_db_connection()
    if not conn: return []
    try:
        clean_name = team_name.strip()

        import time
        cutoff_ts = int(current_match_ts) if current_match_ts else int(time.time())

        # Query archive_matches (existing — tennis/other sports)
        query = """
        SELECT stats_blob, homeTeam, awayTeam, scoreHome, scoreAway, startTimestamp 
        FROM archive_matches 
        WHERE homeTeam = ?
        AND stats_blob IS NOT NULL
        AND scoreHome IS NOT NULL
        AND (startTimestamp IS NULL OR startTimestamp < ?)
        UNION ALL
        SELECT stats_blob, homeTeam, awayTeam, scoreHome, scoreAway, startTimestamp 
        FROM archive_matches 
        WHERE awayTeam = ?
        AND stats_blob IS NOT NULL
        AND scoreHome IS NOT NULL
        AND (startTimestamp IS NULL OR startTimestamp < ?)
        ORDER BY startTimestamp DESC LIMIT ?
        """
        rows = conn.execute(query, (clean_name, cutoff_ts, clean_name, cutoff_ts, limit)).fetchall()
        
        history = []

        for r in rows:
            feats = extract_features_from_stats(r['stats_blob']) or {}
            h_team = r['homeTeam'] or ''
            a_team = r['awayTeam'] or ''
            is_home = (h_team.lower() == clean_name.lower())
            
            norm = {}
            for k, v in feats.items():
                if is_home: norm[k] = v
                else:
                    if '_home' in k: norm[k.replace('_home', '_away')] = v
                    elif '_away' in k: norm[k.replace('_away', '_home')] = v
            
            s_for = r['scoreHome']
            s_ag = r['scoreAway']
            if not is_home: s_for, s_ag = s_ag, s_for
            
            norm['score_for'] = float(s_for) if s_for is not None else 0.0
            norm['score_against'] = float(s_ag) if s_ag is not None else 0.0
            norm['opponent_name'] = a_team if is_home else h_team
            
            if norm['score_for'] > norm['score_against']: norm['points'] = 3.0
            elif norm['score_for'] == norm['score_against']: norm['points'] = 1.0
            else: norm['points'] = 0.0
            
            history.append(norm)

        # Also query archive_football_data (main football source)
        from datetime import datetime
        cutoff_dt = datetime.fromtimestamp(cutoff_ts)
        cutoff_date = cutoff_dt.strftime('%Y-%m-%d')

        query_fb = """
        SELECT home_team, away_team, score_home, score_away, match_date,
               shots_home, shots_away, sot_home, sot_away,
               fouls_home, fouls_away, corners_home, corners_away,
               yellow_home, yellow_away, red_home, red_away
        FROM archive_football_data
        WHERE home_team = ?
        AND odds_home IS NOT NULL
        AND score_home IS NOT NULL
        AND match_date < ?
        UNION ALL
        SELECT home_team, away_team, score_home, score_away, match_date,
               shots_home, shots_away, sot_home, sot_away,
               fouls_home, fouls_away, corners_home, corners_away,
               yellow_home, yellow_away, red_home, red_away
        FROM archive_football_data
        WHERE away_team = ?
        AND odds_home IS NOT NULL
        AND score_home IS NOT NULL
        AND match_date < ?
        ORDER BY match_date DESC LIMIT ?
        """
        rows_fb = conn.execute(query_fb, (clean_name, cutoff_date, clean_name, cutoff_date, limit)).fetchall()

        _STAT_MAP = {
            'shots_home': 'Total shots_home', 'shots_away': 'Total shots_away',
            'sot_home': 'Shots on target_home', 'sot_away': 'Shots on target_away',
            'fouls_home': 'Fouls_home', 'fouls_away': 'Fouls_away',
            'corners_home': 'Corner kicks_home', 'corners_away': 'Corner kicks_away',
            'yellow_home': 'Yellow cards_home', 'yellow_away': 'Yellow cards_away',
            'red_home': 'Red cards_home', 'red_away': 'Red cards_away',
        }

        for r in rows_fb:
            feats = {}
            for col, key in _STAT_MAP.items():
                val = r[col]
                if val is not None:
                    feats[key] = float(val)

            h_team = r['home_team'] or ''
            a_team = r['away_team'] or ''
            is_home = (h_team.lower() == clean_name.lower())

            norm = {}
            for k, v in feats.items():
                if is_home: norm[k] = v
                else:
                    if '_home' in k: norm[k.replace('_home', '_away')] = v
                    elif '_away' in k: norm[k.replace('_away', '_home')] = v

            s_for = r['score_home']
            s_ag = r['score_away']
            if not is_home: s_for, s_ag = s_ag, s_for

            norm['score_for'] = float(s_for) if s_for is not None else 0.0
            norm['score_against'] = float(s_ag) if s_ag is not None else 0.0
            norm['opponent_name'] = a_team if is_home else h_team

            if norm['score_for'] > norm['score_against']: norm['points'] = 3.0
            elif norm['score_for'] == norm['score_against']: norm['points'] = 1.0
            else: norm['points'] = 0.0

            history.append(norm)

        # Also query international_results (World Cup, friendlies, qualifiers)
        query_intl = """
        SELECT home_team, away_team, home_score, away_score, date as match_date, tournament
        FROM international_results
        WHERE home_team = ?
        AND home_score IS NOT NULL
        AND date < ?
        UNION ALL
        SELECT home_team, away_team, home_score, away_score, date as match_date, tournament
        FROM international_results
        WHERE away_team = ?
        AND home_score IS NOT NULL
        AND date < ?
        ORDER BY match_date DESC LIMIT ?
        """
        rows_intl = conn.execute(query_intl, (clean_name, cutoff_date, clean_name, cutoff_date, limit)).fetchall()

        for r in rows_intl:
            h_team = r['home_team'] or ''
            a_team = r['away_team'] or ''
            is_home = (h_team.lower() == clean_name.lower())

            norm = {}
            s_for = r['home_score']
            s_ag = r['away_score']
            if not is_home: s_for, s_ag = s_ag, s_for

            norm['score_for'] = float(s_for) if s_for is not None else 0.0
            norm['score_against'] = float(s_ag) if s_ag is not None else 0.0
            norm['opponent_name'] = a_team if is_home else h_team

            if norm['score_for'] > norm['score_against']: norm['points'] = 3.0
            elif norm['score_for'] == norm['score_against']: norm['points'] = 1.0
            else: norm['points'] = 0.0

            history.append(norm)

        return history[:limit]
    except: return []

def calculate_rolling_averages(history_list, window=30, league_name=''):
    """
    V20 Quantum Decay: Uses a 30-match window with exponential weighting.
    Recent matches have significantly higher influence on the average.
    For cold start (< 3 matches), blends with league-average defaults.
    """
    LEAGUE_AVG_GOALS = 1.2
    LEAGUE_AVG_PTS = 1.0

    if not history_list:
        return LEAGUE_AVG_GOALS, LEAGUE_AVG_PTS

    history = history_list[:min(len(history_list), window)]

    # League-specific decay rates: high-scoring leagues need faster decay
    league_lower = (league_name or '').lower()
    if any(x in league_lower for x in ['bundesliga', 'eredivisie', 'iceland', 'norway', 'sweden']):
        alpha = 0.22  # High-scoring leagues: faster decay for recent form
    elif any(x in league_lower for x in ['serie a', 'ligue 1', 'france', 'national']):
        alpha = 0.12  # Defensive leagues: slower decay, more history matters
    elif any(x in league_lower for x in ['premier league', 'championship', 'champions', 'europa']):
        alpha = 0.18  # Competitive leagues: moderate decay
    else:
        alpha = 0.15  # Default

    for i, m in enumerate(history):
        weight = math.pow(1 - alpha, i)
        weighted_goals += m.get('score_for', 0) * weight
        weighted_points += m.get('points', 0) * weight
        total_weight += weight

    if total_weight == 0:
        return LEAGUE_AVG_GOALS, LEAGUE_AVG_PTS

    avg_goals = weighted_goals / total_weight
    avg_points = weighted_points / total_weight

    # Cold start blend: for < 5 matches, mix in league average to prevent early season volatility
    if len(history_list) < 5:
        blend = len(history_list) / 5.0
        avg_goals = avg_goals * blend + LEAGUE_AVG_GOALS * (1 - blend)
        avg_points = avg_points * blend + LEAGUE_AVG_PTS * (1 - blend)

    return avg_goals, avg_points

def calculate_glicko_momentum(history_list, window=5):
    """
    Momentum V13: Weights points by the strength of the opponent (ELO).
    Gaining 3pts against 1800 ELO > 3pts against 1200 ELO.
    """
    if not history_list: return 0.0
    recent = history_list[:window]
    weighted_scores = []
    
    for m in recent:
        opponent = m.get('opponent_name', 'Unknown')
        opp_elo = _f(ELO_RATINGS.get(opponent), 1500)
        # Strength multiplier: 1500=1.0, 1800=1.2, 1200=0.8
        strength_mult = opp_elo / 1500.0
        weighted_scores.append(_f(m.get('points'), 0) * strength_mult)
        
    return sum(weighted_scores) / len(weighted_scores)

def get_detailed_team_style(stats, league_avg_possession=52.0):
    """
    Tactical DNA 2.0: Infers playstyle relative to the league average.
    Uses league-relative thresholds to avoid misclassifying teams in
    defensive or offensive leagues.
    """
    if not stats: return "Balanced"
    
    pos = stats.get('Ball possession_home') or stats.get('avgPossession') or 50
    if isinstance(pos, str): pos = float(pos.replace('%', ''))
    
    shots = stats.get('Total shots_home') or stats.get('avgShots') or 10
    saves = stats.get('Goalkeeper saves_home') or stats.get('avgSaves') or 2

    # [LEAGUE-RELATIVE FIX] Use offsets from the league average instead of global constants
    high_pos_threshold = league_avg_possession + 4.0  # ~56% in standard leagues
    low_pos_threshold = league_avg_possession - 8.0   # ~44% in standard leagues
    
    if pos > high_pos_threshold: return "Possession"
    if pos < low_pos_threshold and shots > 12: return "Counter-Attack"
    if shots > 16: return "High Press"
    if saves > 4: return "Low Block"
    
    return "Balanced"

def get_rolling_team_style(history_list, league_avg_possession=52.0):
    """
    Aggregates team style across last N matches using weighted voting.
    More robust than single-match style detection.
    """
    if not history_list:
        return "Balanced"
    style_counts = {"Balanced": 0, "Possession": 0, "Counter-Attack": 0, "High Press": 0, "Low Block": 0}
    total_weight = 0
    for i, match_stats in enumerate(history_list):
        weight = 1.0 / (1 + i)  # Most recent match has highest weight
        style = get_detailed_team_style(match_stats, league_avg_possession)
        style_counts[style] += weight
        total_weight += weight
    if total_weight == 0:
        return "Balanced"
    best_style = max(style_counts, key=style_counts.get)
    # Require at least 30% weighted agreement
    if style_counts[best_style] / total_weight < 0.30:
        return "Balanced"
    return best_style

def get_match_motivation_context(row):
    """
    V25 Contextual Intelligence: 
    Detects if a match is a Final, Relegation Battle, or Friendly.
    """
    tournament = str(row.get('tournament_name', '')).lower()
    is_final = any(x in tournament for x in ['final', 'cup', 'trophy', 'play-off'])
    is_friendly = any(x in tournament for x in ['friendly', 'amical', 'club matches', 'world', 'international'])
    
    # 1. Finals (Max Motivation)
    if is_final: return 1.5, "FINAL_CUP"
    
    # 2. Relegation Battle (High Survival Stress)
    form_ctx = row.get('form_context')
    if isinstance(form_ctx, str):
        try: form_ctx = json.loads(form_ctx)
        except: form_ctx = {}
    elif not isinstance(form_ctx, dict):
        form_ctx = {}
    
    h_standing = (form_ctx.get('home') or {}).get('standing', {})
    a_standing = (form_ctx.get('away') or {}).get('standing', {})
    
    h_pos = int(h_standing.get('position', 10))
    a_pos = int(a_standing.get('position', 10))
    
    # Assuming standard 20-team league for threshold
    if h_pos >= 17 or a_pos >= 17:
        return 1.4, "RELEGATION_BATTLE"
    
    # 3. Friendly (Reduced Motivation but Predicted)
    if is_friendly: return 0.85, "FRIENDLY"
    
    return 1.0, "STANDARD"
    
def is_derby_match(home_name, away_name):
    """[V102] Detects local derbies to neutralize naive Home Advantage."""
    # Shared city/stadium keywords
    local_rivals = [
        ("Manchester", "Manchester"), ("Arsenal", "Tottenham"), ("Liverpool", "Everton"),
        ("Milan", "Inter"), ("Lazio", "Roma"), ("Real Madrid", "Atletico"),
        ("Benfica", "Sporting"), ("Porto", "Boavista"), ("Al Hilal", "Al Nassr"),
        ("Al Ittihad", "Al Ahli"), ("Raja", "Wydad"), ("Esperance", "Club Africain")
    ]
    for team1, team2 in local_rivals:
        if team1 in home_name and team2 in away_name: return True
        if team2 in home_name and team1 in away_name: return True
    return False


def _compute_streak(history, stat_fn):
    """Compute consecutive matches matching stat_fn from most recent match backwards."""
    streak = 0
    for m in history:
        if stat_fn(m): streak += 1
        else: break
    return float(streak)


def _hist_rate(history, num_key, den_key, default=0.0):
    """Compute ratio num_key/den_key from history arrays."""
    if not history: return default
    n = sum(m.get(num_key, 0) for m in history if isinstance(m, dict))
    d = sum(m.get(den_key, 0) for m in history if isinstance(m, dict))
    return n / d if d > 0 else default


def _get_h2h_advanced_pg(home_team, away_team):
    """Get H2H stats from Neon PostgreSQL."""
    try:
        h = home_team.strip().lower()
        a = away_team.strip().lower()
        rows = pg_query("""
            SELECT goals_home, goals_away FROM soccer_fixtures
            WHERE (LOWER(home_team) = %s AND LOWER(away_team) = %s)
               OR (LOWER(home_team) = %s AND LOWER(away_team) = %s)
            AND goals_home IS NOT NULL AND goals_away IS NOT NULL
            ORDER BY date DESC LIMIT 20
        """, (h, a, a, h))
        if not rows:
            return {}
        total_goals_list = []
        over25 = 0
        for r in rows:
            sH = float(r.get('goals_home') or 0)
            sA = float(r.get('goals_away') or 0)
            tg = sH + sA
            total_goals_list.append(tg)
            if tg > 2.5:
                over25 += 1
        n = len(rows)
        return {
            'avg_total_goals': sum(total_goals_list) / n,
            'over25_rate': over25 / n,
            'avg_xg': 0,
            'total_matches': n
        }
    except Exception:
        return {}

@functools.lru_cache(maxsize=256)
def get_h2h_advanced(home_team, away_team, current_match_ts=None):
    """Get detailed H2H stats (avg goals, xG, over rate) from archive."""
    # Use Neon PostgreSQL first if available
    if using_postgres():
        pg_h2h = _get_h2h_advanced_pg(home_team, away_team)
        if pg_h2h:
            return pg_h2h

    conn = get_db_connection()
    if not conn: return {}
    try:
        h = home_team.strip()
        a = away_team.strip()
        import time
        cutoff_ts = int(current_match_ts) if current_match_ts else int(time.time())
        rows = conn.execute("""
            SELECT stats_blob, homeTeam, awayTeam, scoreHome, scoreAway
            FROM archive_matches
            WHERE ((homeTeam = ? AND awayTeam = ?) OR (homeTeam = ? AND awayTeam = ?))
            AND scoreHome IS NOT NULL
            AND (startTimestamp IS NULL OR startTimestamp < ?)
            ORDER BY startTimestamp DESC LIMIT 20
        """, (h, a, a, h, cutoff_ts)).fetchall()
        if not rows: return {}
        total_goals_list = []
        xg_total = 0.0
        xg_count = 0
        over25 = 0
        for r in rows:
            sH = float(r['scoreHome'] or 0)
            sA = float(r['scoreAway'] or 0)
            tg = sH + sA
            total_goals_list.append(tg)
            if tg > 2.5: over25 += 1
            feats = extract_features_from_stats(r['stats_blob'])
            if feats:
                xgh = feats.get('Expected goals_home', 0)
                xga = feats.get('Expected goals_away', 0)
                if xgh > 0 and xga > 0:
                    xg_total += xgh + xga
                    xg_count += 1
        n = len(rows)
        return {
            'avg_total_goals': sum(total_goals_list) / n,
            'over25_rate': over25 / n,
            'avg_xg': xg_total / xg_count if xg_count else 0,
            'total_matches': n
        }
    except:
        return {}


def calculate_data_completeness(features):
    """V25 Reliability Score Component: Measures feature density."""
    essential = ['h_xg', 'a_xg', 'h_pos', 'a_pos', 'h_sot', 'a_sot']
    found = sum(1 for f in essential if features.get(f, 0) > 0)
    return (found / len(essential)) * 100

def calculate_momentum_trend(graph_data):
    """
    V26 Elite Intelligence: Analyzes the Sofascore Attack Momentum graph.
    Returns: (home_pressure, away_pressure, trend_slope)
    """
    if not graph_data or 'graphPoints' not in graph_data:
        return 0.0, 0.0, 0.0
    
    points = graph_data['graphPoints']
    if not points: return 0.0, 0.0, 0.0
    
    # Values: > 0 (Home Pressure), < 0 (Away Pressure)
    home_vals = [p['value'] for p in points if p['value'] > 0]
    away_vals = [abs(p['value']) for p in points if p['value'] < 0]
    
    h_avg = sum(home_vals) / len(home_vals) if home_vals else 0.0
    a_avg = sum(away_vals) / len(away_vals) if away_vals else 0.0
    
    # Recent Trend (last 5 points)
    recent = points[-5:] if len(points) >= 5 else points
    trend = 0.0
    if len(recent) >= 2:
        trend = recent[-1]['value'] - recent[0]['value']
        
    return h_avg, a_avg, trend

def calculate_travel_fatigue(home_country, away_country):
    """
    [DISTANCE-AWARE] Estimates away team travel fatigue based on geographic distance.
    Returns a fatigue multiplier (0.0 = no extra fatigue, higher = more fatigued).
    """
    if not home_country or not away_country or home_country == away_country:
        return 0.0

    # Continent groupings for distance estimation
    CONTINENT_MAP = {
        'europe': ['england', 'spain', 'france', 'germany', 'italy', 'portugal', 'netherlands',
                   'belgium', 'scotland', 'turkey', 'greece', 'switzerland', 'austria', 'sweden',
                   'denmark', 'norway', 'poland', 'czech', 'russia', 'ukraine', 'croatia', 'serbia'],
        'south_america': ['brazil', 'argentina', 'colombia', 'chile', 'uruguay', 'peru', 'ecuador', 'venezuela'],
        'north_america': ['usa', 'mexico', 'canada', 'costa rica', 'honduras', 'guatemala'],
        'africa': ['morocco', 'egypt', 'nigeria', 'senegal', 'ghana', 'ivory coast', 'cameroon', 
                   'south africa', 'algeria', 'tunisia', 'kenya', 'ethiopia'],
        'asia': ['japan', 'south korea', 'china', 'saudi arabia', 'uae', 'qatar', 'iran',
                 'india', 'australia', 'thailand', 'indonesia'],
        'middle_east': ['saudi arabia', 'uae', 'qatar', 'iran', 'iraq', 'jordan', 'kuwait']
    }

    def get_continent(country):
        c = (country or '').lower()
        for continent, countries in CONTINENT_MAP.items():
            if any(x in c for x in countries):
                return continent
        return 'unknown'

    home_cont = get_continent(home_country)
    away_cont = get_continent(away_country)

    if home_cont == away_cont and home_cont != 'unknown':
        return 0.8   # Same continent — minimal fatigue (e.g., Madrid → London)
    elif home_cont == 'unknown' or away_cont == 'unknown':
        return 1.2   # Unknown geography — moderate conservative penalty
    else:
        return 2.0   # Intercontinental — heavy fatigue (e.g., Tokyo → London)


def calculate_cumulative_fatigue(history_list, num_matches=3):
    """
    Ultra Factor: Estimates cumulative fatigue based on recent match intensity.
    Uses the last N matches to estimate physiological load.
    Returns a fatigue coefficient (0.85 to 1.0) where lower = more fatigued.
    """
    if not history_list: return 1.0
    
    recent = history_list[:min(len(history_list), num_matches)]
    fatigue_score = 1.0
    
    # Base penalty for having played exactly N matches recently (proxy for tight schedule)
    if len(recent) >= 3:
        fatigue_score -= 0.05
        
    for match in recent:
        # Heavily contested matches (close scores) add to fatigue
        sf = match.get('score_for', 0)
        sa = match.get('score_against', 0)
        
        if abs(sf - sa) <= 1:
            fatigue_score -= 0.02
            
        # Physicality factors: low possession means more running/chasing the ball
        poss = match.get('Ball possession_home', match.get('Ball possession_away', 50.0))
        if poss < 40.0:
            fatigue_score -= 0.015
            
        # High tackle volume implies higher physical intensity
        tackles = match.get('Tackles_home', match.get('Tackles_away', 15.0))
        if tackles > 18.0:
            fatigue_score -= 0.015
            
    # Cap the penalty to avoid catastrophic drops
    return max(0.85, fatigue_score)

def calculate_injury_impact(news_data, team_name):
    """[ROLE-WEIGHTED] Injury impact respects player position criticality."""
    if not news_data: return 0.0
    # Role-based impact weights (GK and playmaker absence hurts most)
    ROLE_IMPACT = {
        'goalkeeper': 4.5, 'keeper': 4.5, 'gk': 4.5,
        'playmaker': 4.0, 'captain': 3.5,
        'striker': 3.0, 'forward': 3.0,
        'defender': 2.5, 'center-back': 2.5,
        'midfielder': 2.0, 'winger': 2.0
    }
    try:
        news = json.loads(news_data) if isinstance(news_data, str) else news_data
        injuries = news.get('injuries', {})
        h_name = news.get('homeTeam', '')
        team_type = 'home' if team_name == h_name else 'away'
        players = injuries.get(team_type, [])
        if not players: return 0.0
        
        style_data = TEAM_STYLES.get(team_name, {})
        key_players = style_data.get('key_players', [])
        
        impact = 0.0
        for p in players:
            p_name = p if isinstance(p, str) else (p.get('name', '') if isinstance(p, dict) else '')
            p_role = p.get('position', '').lower() if isinstance(p, dict) else ''

            # Check role-based weight first
            role_w = 1.0
            for role_key, role_val in ROLE_IMPACT.items():
                if role_key in p_role:
                    role_w = role_val
                    break

            # Key player bonus
            if any(kp.lower() in p_name.lower() for kp in key_players):
                impact += max(role_w, 3.0)
            else:
                impact += role_w
        return impact
    except:
        return 0.0

def calculate_motivation(standing, total_teams=20):
    if not standing: return 1.0
    try:
        pos = int(standing.get('position', 10))
        matches = int(standing.get('matches', 0))
        if matches > (total_teams * 0.7):
            if pos <= 3: return 1.25
            if pos >= total_teams - 3: return 1.35
            if 8 <= pos <= 13: return 0.85
    except: pass
    return 1.0

def get_tactical_synergy(home_name, away_name):
    h_style = TEAM_STYLES.get(home_name, {}).get('style', 'Balanced')
    a_style = TEAM_STYLES.get(away_name, {}).get('style', 'Balanced')
    if a_style == 'Counter-Attack' and h_style == 'Possession':
        return 1.2
    if h_style == 'Counter-Attack' and a_style == 'Possession':
        return 0.8
    return 1.0

# Tunisia Crowdsourcing Features
_TUNISIAN_VOTES_CACHE = None

def _load_tunisian_votes():
    """Load Tunisian vote history from disk (cached)."""
    global _TUNISIAN_VOTES_CACHE
    if _TUNISIAN_VOTES_CACHE is None:
        try:
            vote_path = os.path.join(os.path.dirname(__file__), '..', 'data', 'tunisian_vote_history.json')
            if os.path.exists(vote_path):
                with open(vote_path, 'r', encoding='utf-8') as f:
                    _TUNISIAN_VOTES_CACHE = json.load(f)
            else:
                _TUNISIAN_VOTES_CACHE = []
        except Exception:
            _TUNISIAN_VOTES_CACHE = []
    return _TUNISIAN_VOTES_CACHE

def _find_tunisian_votes_for_match(home_team, away_team):
    """Find Tunisian crowd votes for a specific match."""
    votes = _load_tunisian_votes()
    for entry in votes:
        if entry.get('home') == home_team and entry.get('away') == away_team:
            return entry
    return None

def _calculate_vote_consent(vote1, voteX, vote2):
    """
    Calculate vote consensus ratio.
    Returns: ratio of dominant vote (0.5 = neutral, 1.0 = full consensus)
    """
    if vote1 is None or voteX is None or vote2 is None:
        return 0.5
    total = vote1 + voteX + vote2
    if total == 0:
        return 0.5
    max_vote = max(vote1, voteX, vote2)
    return max_vote / total

def _calculate_vote_sentiment(vote1, voteX, vote2):
    """
    Calculate vote sentiment (0 = away bias, 0.5 = neutral, 1 = home bias)
    """
    if vote1 is None or voteX is None or vote2 is None:
        return 0.5
    total = vote1 + voteX + vote2
    if total == 0:
        return 0.5
    # Weighted: 1 > X > 2 for sentiment toward home
    return (vote1 + 0.5 * voteX) / total

def _calculate_vote_divergence(vote1, voteX, vote2):
    """
    Calculate vote divergence (entropy-based).
    Returns: 0 = full consensus, 1 = maximum divergence
    """
    if vote1 is None or voteX is None or vote2 is None:
        return 0.5
    total = vote1 + voteX + vote2
    if total == 0:
        return 0.5
    p1, px, p2 = vote1/total, voteX/total, vote2/total
    # Shannon entropy normalized to [0, 1]
    entropy = 0
    for p in [p1, px, p2]:
        if p > 0:
            entropy -= p * math.log2(p)
    max_entropy = math.log2(3)  # Maximum entropy for 3 outcomes
    return entropy / max_entropy if max_entropy > 0 else 0.5

def _calculate_jackpot_pressure(cagnotte):
    """
    Calculate jackpot pressure (inverse of normalized cagnotte).
    Higher cagnotte = lower pressure (people play it safe).
    Returns: 0 to 1 scale (1 = maximum pressure, low jackpot)
    """
    if cagnotte is None:
        return 0.5
    # Normalize: assume 10000 TND is "normal", above is low pressure, below is high pressure
    # Pressure = 1 - min(cagnotte/10000, 1)
    return max(0, 1 - min(cagnotte / 10000, 1))

def _calculate_crowd_conviction(vote1, voteX, vote2):
    """
    Calculate crowd conviction (how confident the crowd is).
    Returns: 0 to 1 scale (higher = more confident consensus)
    """
    consent = _calculate_vote_consent(vote1, voteX, vote2)
    divergence = _calculate_vote_divergence(vote1, voteX, vote2)
    # Conviction = consensus * (1 - divergence)
    return consent * (1 - divergence)

def extract_tunisian_features(home_team, away_team):
    """
    Extract Tunisia-specific crowd features for a match.
    Returns dict with all Tunisia features or zeros if no data.
    """
    entry = _find_tunisian_votes_for_match(home_team, away_team)
    
    if not entry:
        return {
            'h_tn_vote_consent': 0.5, 'a_tn_vote_consent': 0.5, 'tn_vote_consent_diff': 0.0,
            'h_tn_vote_sentiment': 0.5, 'a_tn_vote_sentiment': 0.5, 'tn_vote_sentiment_diff': 0.0,
            'h_tn_vote_divergence': 0.5, 'a_tn_vote_divergence': 0.5, 'tn_vote_divergence_diff': 0.0,
            'h_tn_vote_volatility': 0.0, 'a_tn_vote_volatility': 0.0, 'tn_vote_volatility_diff': 0.0,
            'h_tn_jackpot_pressure': 0.5, 'a_tn_jackpot_pressure': 0.5, 'tn_jackpot_pressure_diff': 0.0,
            'h_tn_crowd_conviction': 0.5, 'a_tn_crowd_conviction': 0.5, 'tn_crowd_conviction_diff': 0.0
        }
    
    # Extract vote data
    public_vote = entry.get('publicVote') or entry.get('vote_data') or {}
    vote1 = public_vote.get('p1') if isinstance(public_vote, dict) else entry.get('vote1')
    voteX = public_vote.get('px') if isinstance(public_vote, dict) else entry.get('voteX')
    vote2 = public_vote.get('p2') if isinstance(public_vote, dict) else entry.get('vote2')
    cagnotte = entry.get('cagnotte')
    
    # Home team features (assuming home team is the focus)
    h_consent = _calculate_vote_consent(vote1, voteX, vote2)
    a_consent = 1 - h_consent  # Away consent is complementary
    h_sentiment = _calculate_vote_sentiment(vote1, voteX, vote2)
    a_sentiment = 1 - h_sentiment
    h_divergence = _calculate_vote_divergence(vote1, voteX, vote2)
    a_divergence = h_divergence  # Divergence is symmetric
    h_volatility = 0.1  # Base volatility (would need historical data for real calculation)
    a_volatility = h_volatility
    h_jackpot = _calculate_jackpot_pressure(cagnotte)
    a_jackpot = h_jackpot  # Same pressure for both teams
    h_conviction = _calculate_crowd_conviction(vote1, voteX, vote2)
    a_conviction = h_conviction
    
    return {
        'h_tn_vote_consent': h_consent,
        'a_tn_vote_consent': a_consent,
        'tn_vote_consent_diff': h_consent - a_consent,
        'h_tn_vote_sentiment': h_sentiment,
        'a_tn_vote_sentiment': a_sentiment,
        'tn_vote_sentiment_diff': h_sentiment - a_sentiment,
        'h_tn_vote_divergence': h_divergence,
        'a_tn_vote_divergence': a_divergence,
        'tn_vote_divergence_diff': h_divergence - a_divergence,
        'h_tn_vote_volatility': h_volatility,
        'a_tn_vote_volatility': a_volatility,
        'tn_vote_volatility_diff': h_volatility - a_volatility,
        'h_tn_jackpot_pressure': h_jackpot,
        'a_tn_jackpot_pressure': a_jackpot,
        'tn_jackpot_pressure_diff': h_jackpot - a_jackpot,
        'h_tn_crowd_conviction': h_conviction,
        'a_tn_crowd_conviction': a_conviction,
        'tn_crowd_conviction_diff': h_conviction - a_conviction
    }

def extract_ml_features(row, fetch_history=True, current_match_ts=None):
    features = {}
    
    home_name = row.get('homeTeam', 'Home')
    away_name = row.get('awayTeam', 'Away')
    _league_name = row.get('league', '') or row.get('tournament_name', '')

    # 0. Elo Ratings
    features['home_elo'] = _f(ELO_RATINGS.get(home_name), 1500)
    features['away_elo'] = _f(ELO_RATINGS.get(away_name), 1500)
    features['elo_diff'] = features['home_elo'] - features['away_elo']

    # 1. Motivation (ULTRA)
    form_ctx = row.get('form_context')
    if not form_ctx: form_ctx = {}
    if isinstance(form_ctx, str):
        try: form_ctx = json.loads(form_ctx)
        except: form_ctx = {}
    if not isinstance(form_ctx, dict): form_ctx = {}
    
    h_form = form_ctx.get('home') or {}
    a_form = form_ctx.get('away') or {}
    
    features['home_motivation'] = calculate_motivation(h_form.get('standing'))
    features['away_motivation'] = calculate_motivation(a_form.get('standing'))

    # 2. Tactical Synergy (ULTRA)
    features['tactical_synergy'] = get_tactical_synergy(home_name, away_name)

    # 3. Squad Depth (ULTRA)
    news_data = row.get('news_data')
    features['home_injury_impact'] = calculate_injury_impact(news_data, home_name)
    features['away_injury_impact'] = calculate_injury_impact(news_data, away_name)

    # 4. Momentum (Rolling Averages)
    if fetch_history:
        h_hist = get_team_history(home_name, limit=20, current_match_ts=current_match_ts)
        a_hist = get_team_history(away_name, limit=20, current_match_ts=current_match_ts)
    else:
        h_hist = row.get('history_home', [])
        a_hist = row.get('history_away', [])

    h_roll_g3, h_roll_p3 = calculate_rolling_averages(h_hist, window=3, league_name=_league_name)
    a_roll_g3, a_roll_p3 = calculate_rolling_averages(a_hist, window=3, league_name=_league_name)
    features['home_momentum_goals'] = h_roll_g3
    features['home_momentum_points'] = h_roll_p3
    features['away_momentum_goals'] = a_roll_g3
    features['away_momentum_points'] = a_roll_p3
    
    # 5. Cumulative Fatigue (ULTRA)
    if fetch_history:
        features['h_fatigue_cumulative'] = calculate_cumulative_fatigue(h_hist)
        features['a_fatigue_cumulative'] = calculate_cumulative_fatigue(a_hist)
    else:
        features['h_fatigue_cumulative'] = 1.0
        features['a_fatigue_cumulative'] = 1.0
    
    # V13 Advanced Momentum
    features['home_glicko_momentum'] = calculate_glicko_momentum(h_hist)
    features['away_glicko_momentum'] = calculate_glicko_momentum(a_hist)
    # Fallback to teamStats if history is empty (early season)
    team_stats_raw = row.get('teamStats')
    if team_stats_raw is None: team_stats_raw = '{}'
    
    try:
        ts = json.loads(team_stats_raw) if isinstance(team_stats_raw, str) else team_stats_raw
    except:
        ts = {}
        
    if not isinstance(ts, dict): ts = {}
    ts_h = ts.get('home') if isinstance(ts.get('home'), dict) else {}
    ts_a = ts.get('away') if isinstance(ts.get('away'), dict) else {}

    # [V54 ROW-LEVEL FALLBACK] Inject archive columns into ts_h/ts_a
    # so _get_avg_hist / _get_decayed_avg find real values when teamStats missing
    _ROW_FALLBACK = {
        'avgPossession':       ('home_possession', 'away_possession'),
        'avgShots':            ('home_shots', 'away_shots'),
        'avgShotsOnTarget':    ('home_shots_on_target', 'away_shots_on_target'),
        'avgShotsOffTarget':   ('home_shots_off', 'away_shots_off'),
        'avgCorners':          ('home_corners', 'away_corners'),
        'avgFouls':            ('home_fouls', 'away_fouls'),
        'expectedGoals':       ('home_xg', 'away_xg'),
        'goalsAgainst':        ('home_goals_conceded', 'away_goals_conceded'),
    }
    for ts_key, (h_col, a_col) in _ROW_FALLBACK.items():
        if ts_key not in ts_h:
            try:
                v = row.get(h_col)
                if v is not None: ts_h[ts_key] = float(v)
            except: pass
        if ts_key not in ts_a:
            try:
                v = row.get(a_col)
                if v is not None: ts_a[ts_key] = float(v)
            except: pass

    def _resolve_key(hist, key):
        """Try both title-case (teamStats list format) and snake_case (stats_blob dict format)."""
        if isinstance(hist, list) and len(hist) > 0 and isinstance(hist[0], dict):
            if key in hist[0]:
                return key
            snake = key.lower().replace(' ', '_').replace("'", '').replace('-', '_')
            if snake in hist[0]:
                return snake
        return key

    def _get_avg_hist(hist, key, ts_dict, ts_key, default=0.0):
        # Extracts from history arrays, falling back to team season stats if history fails
        resolved = _resolve_key(hist, key)
        if isinstance(hist, list) and len(hist) > 0 and isinstance(hist[0], dict) and resolved in hist[0]:
            vals = [m.get(resolved, default) for m in hist if isinstance(m, dict)]
            return sum(vals)/len(vals) if vals else default
        
        # Safe access to ts_dict
        if isinstance(ts_dict, dict):
            try:
                return float(ts_dict.get(ts_key, default))
            except (ValueError, TypeError):
                return float(default)
        return float(default)

    def _get_decayed_avg(hist, key, ts_dict, ts_key, default=0.0, alpha=0.20):
        """Time-decayed weighted average — recent matches matter more."""
        resolved = _resolve_key(hist, key)
        if isinstance(hist, list) and len(hist) > 0 and isinstance(hist[0], dict) and resolved in hist[0]:
            vals = [m.get(resolved, default) for m in hist if isinstance(m, dict)]
            if not vals: return default
            weights = [math.pow(1 - alpha, i) for i in range(len(vals))]
            tw = sum(weights)
            if tw == 0: return sum(vals) / len(vals)
            return sum(v * w for v, w in zip(vals, weights)) / tw
        if isinstance(ts_dict, dict):
            try:
                return float(ts_dict.get(ts_key, default))
            except:
                return float(default)
        return float(default)

    # 🌍 [STITCH V19 TITANIUM] Expanded Micro-Statistics (115+ Variables)
    # This section extracts deep tactical metrics for advanced pattern recognition.
    
    def _get_dual_stat(feat_dict, cat, ts_dict, ts_key, default=0.0):
        h = _get_avg_hist(h_hist, f'{cat}_home', ts_h, ts_key, default)
        a = _get_avg_hist(a_hist, f'{cat}_away', ts_a, ts_key, default)
        diff = h - a
        return h, a, diff

    # 1. Possession & Precision
    features['h_pos'], features['a_pos'], features['pos_diff'] = _get_dual_stat(features, 'Ball possession', ts_h, 'avgPossession', 50.0)
    features['h_pass_acc'], features['a_pass_acc'], features['pass_acc_diff'] = _get_dual_stat(features, 'Accurate passes', ts_h, 'passAccuracyPct', 80.0)
    
    # 2. Attack Dynamics
    h_xg_raw = row.get('home_xg') or ts_h.get('expectedGoals')
    a_xg_raw = row.get('away_xg') or ts_a.get('expectedGoals')
    if not h_xg_raw:
        h_xg_raw = _predict_xg_h(row, ts_h)
    if not a_xg_raw:
        a_xg_raw = _predict_xg_a(row, ts_a)
    features['h_xg'] = _f(h_xg_raw, 1.0)
    features['a_xg'] = _f(a_xg_raw, 1.0)
    features['xg_diff'] = features['h_xg'] - features['a_xg']
    features['h_bc'], features['a_bc'], features['bc_diff'] = _get_dual_stat(features, 'Big chances', ts_h, 'avgBigChances', 1.5)
    features['h_sot'], features['a_sot'], features['sot_diff'] = _get_dual_stat(features, 'Shots on target', ts_h, 'avgShotsOnTarget', 4.0)
    features['h_shots_off'], features['a_shots_off'], _ = _get_dual_stat(features, 'Shots off target', ts_h, 'avgShotsOffTarget', 5.0)
    features['h_inner_shots'], features['a_inner_shots'], _ = _get_dual_stat(features, 'Shots from inside box', ts_h, 'avgShotsInsideBox', 6.0)

    # 3. Defensive & Disruptive
    features['h_int'], features['a_int'], features['int_diff'] = _get_dual_stat(features, 'Interceptions', ts_h, 'avgInterceptions', 10.0)
    features['h_tackles'], features['a_tackles'], features['tackles_diff'] = _get_dual_stat(features, 'Tackles', ts_h, 'avgTackles', 15.0)
    features['h_clear'], features['a_clear'], features['clear_diff'] = _get_dual_stat(features, 'Clearances', ts_h, 'avgClearances', 18.0)
    features['h_def_err'], features['a_def_err'], _ = _get_dual_stat(features, 'Errors leading to goal', ts_h, 'errorsLeadingToGoal', 0.0)
    features['h_saves'], features['a_saves'], _ = _get_dual_stat(features, 'Goalkeeper saves', ts_h, 'avgSaves', 3.0)

    # 4. Duel & Physicality
    features['h_ground_won'], features['a_ground_won'], _ = _get_dual_stat(features, 'Ground duels won', ts_h, 'avgGroundDuelsWon', 40.0)
    features['h_aerial_won'], features['a_aerial_won'], _ = _get_dual_stat(features, 'Aerial duels won', ts_h, 'avgAerialDuelsWon', 15.0)
    features['h_poss_lost'], features['a_poss_lost'], features['lost_diff'] = _get_dual_stat(features, 'Possession lost', ts_h, 'avgPossessionLost', 130.0)

    # 5. Discipline & Set Pieces
    features['h_corners'], features['a_corners'], features['corner_diff'] = _get_dual_stat(features, 'Corner kicks', ts_h, 'avgCorners', 4.5)
    features['h_fouls'], features['a_fouls'], features['foul_diff'] = _get_dual_stat(features, 'Fouls', ts_h, 'avgFouls', 12.0)
    h_y = _get_avg_hist(h_hist, 'Yellow cards_home', ts_h, 'avgYellowCards', 2.0)
    a_y = _get_avg_hist(a_hist, 'Yellow cards_away', ts_a, 'avgYellowCards', 2.0)
    features['h_cards'], features['a_cards'] = h_y, a_y

    # 6. Stylistic & Momentum (V13/V19 Fusion)
    # V55 FIX: Use rolling window of last 5 matches for style detection (single match too noisy)
    h_style_matches = h_hist[:5] if h_hist else []
    a_style_matches = a_hist[:5] if a_hist else []
    h_style = get_rolling_team_style(h_style_matches)
    a_style = get_rolling_team_style(a_style_matches)
    _STYLE_MAP = {"Balanced": 0, "Possession": 1, "Counter-Attack": 2, "High Press": 3, "Low Block": 4}
    features['h_style_enc'] = _STYLE_MAP.get(h_style, 0)
    features['a_style_enc'] = _STYLE_MAP.get(a_style, 0)
    features['h_mom_gicko'] = calculate_glicko_momentum(h_hist)
    features['a_mom_gicko'] = calculate_glicko_momentum(a_hist)

    # 6b. V53 SofaScore Advanced Stats (already in teamStats, time-decayed)
    features['h_successful_dribbles'] = _get_decayed_avg(h_hist, 'Successful dribbles_home', ts_h, 'avgSuccessfulDribbles', 5.0)
    features['a_successful_dribbles'] = _get_decayed_avg(a_hist, 'Successful dribbles_away', ts_a, 'avgSuccessfulDribbles', 5.0)
    features['h_accurate_long_balls'] = _get_decayed_avg(h_hist, 'Accurate long balls_home', ts_h, 'avgAccurateLongBalls', 15.0)
    features['a_accurate_long_balls'] = _get_decayed_avg(a_hist, 'Accurate long balls_away', ts_a, 'avgAccurateLongBalls', 15.0)
    features['h_accurate_crosses'] = _get_decayed_avg(h_hist, 'Accurate crosses_home', ts_h, 'avgAccurateCrosses', 3.0)
    features['a_accurate_crosses'] = _get_decayed_avg(a_hist, 'Accurate crosses_away', ts_a, 'avgAccurateCrosses', 3.0)
    features['h_opp_half_passes'] = _get_decayed_avg(h_hist, 'Opposition half passes_home', ts_h, 'avgOppositionHalfPasses', 150.0)
    features['a_opp_half_passes'] = _get_decayed_avg(a_hist, 'Opposition half passes_away', ts_a, 'avgOppositionHalfPasses', 150.0)
    features['h_duels_won_pct'] = _get_decayed_avg(h_hist, 'Duels won percentage_home', ts_h, 'duelsWonPct', 50.0)
    features['a_duels_won_pct'] = _get_decayed_avg(a_hist, 'Duels won percentage_away', ts_a, 'duelsWonPct', 50.0)
    features['h_errors_leading_to_shot'] = _get_decayed_avg(h_hist, 'Errors leading to shot_home', ts_h, 'errorsLeadingToShot', 0.5)
    features['a_errors_leading_to_shot'] = _get_decayed_avg(a_hist, 'Errors leading to shot_away', ts_a, 'errorsLeadingToShot', 0.5)

    # 6c. V54 Enhanced Passing Detail
    features['h_accurate_opp_half_passes'] = _get_decayed_avg(h_hist, 'Accurate opposition half passes_home', ts_h, 'avgAccurateOppositionHalfPasses', 80.0)
    features['a_accurate_opp_half_passes'] = _get_decayed_avg(a_hist, 'Accurate opposition half passes_away', ts_a, 'avgAccurateOppositionHalfPasses', 80.0)
    features['h_opp_half_pass_pct'] = _get_decayed_avg(h_hist, 'Accurate opposition half passes percentage_home', ts_h, 'accurateOppositionHalfPassesPct', 80.0)
    features['a_opp_half_pass_pct'] = _get_decayed_avg(a_hist, 'Accurate opposition half passes percentage_away', ts_a, 'accurateOppositionHalfPassesPct', 80.0)
    features['h_acc_own_half_passes'] = _get_decayed_avg(h_hist, 'Accurate own half passes_home', ts_h, 'avgAccurateOwnHalfPasses', 150.0)
    features['a_acc_own_half_passes'] = _get_decayed_avg(a_hist, 'Accurate own half passes_away', ts_a, 'avgAccurateOwnHalfPasses', 150.0)
    features['h_long_ball_pct'] = _get_decayed_avg(h_hist, 'Accurate long balls percentage_home', ts_h, 'accurateLongBallsPct', 50.0)
    features['a_long_ball_pct'] = _get_decayed_avg(a_hist, 'Accurate long balls percentage_away', ts_a, 'accurateLongBallsPct', 50.0)
    features['h_cross_pct'] = _get_decayed_avg(h_hist, 'Accurate crosses percentage_home', ts_h, 'accurateCrossesPct', 25.0)
    features['a_cross_pct'] = _get_decayed_avg(a_hist, 'Accurate crosses percentage_away', ts_a, 'accurateCrossesPct', 25.0)

    # 6d. V54 Ground & Aerial Duel Detail
    features['h_ground_duels_won'] = _get_decayed_avg(h_hist, 'Ground duels won_home', ts_h, 'avgGroundDuelsWon', 20.0)
    features['a_ground_duels_won'] = _get_decayed_avg(a_hist, 'Ground duels won_away', ts_a, 'avgGroundDuelsWon', 20.0)
    features['h_ground_duel_pct'] = _get_decayed_avg(h_hist, 'Ground duels won percentage_home', ts_h, 'groundDuelsWonPct', 50.0)
    features['a_ground_duel_pct'] = _get_decayed_avg(a_hist, 'Ground duels won percentage_away', ts_a, 'groundDuelsWonPct', 50.0)
    features['h_aerial_duel_pct'] = _get_decayed_avg(h_hist, 'Aerial duels won percentage_home', ts_h, 'aerialDuelsWonPct', 50.0)
    features['a_aerial_duel_pct'] = _get_decayed_avg(a_hist, 'Aerial duels won percentage_away', ts_a, 'aerialDuelsWonPct', 50.0)
    features['h_total_duels'] = _get_decayed_avg(h_hist, 'Total duels_home', ts_h, 'avgTotalDuels', 40.0)
    features['a_total_duels'] = _get_decayed_avg(a_hist, 'Total duels_away', ts_a, 'avgTotalDuels', 40.0)

    # 6e. V54 Ball Recovery & Blocks
    features['h_ball_recovery'] = _get_decayed_avg(h_hist, 'Ball recovery_home', ts_h, 'avgBallRecovery', 20.0)
    features['a_ball_recovery'] = _get_decayed_avg(a_hist, 'Ball recovery_away', ts_a, 'avgBallRecovery', 20.0)
    features['h_blocked_shots'] = _get_decayed_avg(h_hist, 'Blocked scoring attempt_home', ts_h, 'avgBlockedScoringAttempt', 3.0)
    features['a_blocked_shots'] = _get_decayed_avg(a_hist, 'Blocked scoring attempt_away', ts_a, 'avgBlockedScoringAttempt', 3.0)
    features['h_assists'] = _get_decayed_avg(h_hist, 'Assists_home', ts_h, 'avgAssists', 1.5)
    features['a_assists'] = _get_decayed_avg(a_hist, 'Assists_away', ts_a, 'avgAssists', 1.5)

    # 6f. V54 Defensive "Against" (opponent perspective — how much pressure a team faces)
    features['h_shots_faced'] = _get_decayed_avg(h_hist, 'Shots against_home', ts_h, 'avgShotsAgainst', 10.0)
    features['a_shots_faced'] = _get_decayed_avg(a_hist, 'Shots against_away', ts_a, 'avgShotsAgainst', 10.0)
    features['h_sot_faced'] = _get_decayed_avg(h_hist, 'Shots on target against_home', ts_h, 'avgShotsOnTargetAgainst', 4.0)
    features['a_sot_faced'] = _get_decayed_avg(a_hist, 'Shots on target against_away', ts_a, 'avgShotsOnTargetAgainst', 4.0)
    features['h_bc_conceded'] = _get_decayed_avg(h_hist, 'Big chances against_home', ts_h, 'avgBigChancesAgainst', 2.0)
    features['a_bc_conceded'] = _get_decayed_avg(a_hist, 'Big chances against_away', ts_a, 'avgBigChancesAgainst', 2.0)
    features['h_key_passes_allowed'] = _get_decayed_avg(h_hist, 'Key passes against_home', ts_h, 'avgKeyPassesAgainst', 5.0)
    features['a_key_passes_allowed'] = _get_decayed_avg(a_hist, 'Key passes against_away', ts_a, 'avgKeyPassesAgainst', 5.0)
    features['h_corners_conceded'] = _get_decayed_avg(h_hist, 'Corners against_home', ts_h, 'avgCornersAgainst', 5.0)
    features['a_corners_conceded'] = _get_decayed_avg(a_hist, 'Corners against_away', ts_a, 'avgCornersAgainst', 5.0)
    features['h_dribbles_allowed'] = _get_decayed_avg(h_hist, 'Dribble attempts won against_home', ts_h, 'avgDribbleAttemptsWonAgainst', 5.0)
    features['a_dribbles_allowed'] = _get_decayed_avg(a_hist, 'Dribble attempts won against_away', ts_a, 'avgDribbleAttemptsWonAgainst', 5.0)

    # 6g. V54 Computed Proxies (FBref replacements)
    features['h_ppda'] = _get_decayed_avg(h_hist, 'PPDA proxy_home', ts_h, 'ppdaProxy', 15.0)
    features['a_ppda'] = _get_decayed_avg(a_hist, 'PPDA proxy_away', ts_a, 'ppdaProxy', 15.0)
    features['h_prog_passes'] = _get_decayed_avg(h_hist, 'Progressive passes proxy_home', ts_h, 'progressivePassesProxy', 20.0)
    features['a_prog_passes'] = _get_decayed_avg(a_hist, 'Progressive passes proxy_away', ts_a, 'progressivePassesProxy', 20.0)
    features['h_sca'] = _get_decayed_avg(h_hist, 'Shot-creating actions proxy_home', ts_h, 'shotCreatingActionsProxy', 5.0)
    features['a_sca'] = _get_decayed_avg(a_hist, 'Shot-creating actions proxy_away', ts_a, 'shotCreatingActionsProxy', 5.0)

    # 7. Market & Environmental (TITANIUM)
    features['h_att_imp'] = float(row.get('home_att') or 1.0)
    features['a_att_imp'] = float(row.get('away_att') or 1.0)
    features['news_sent'] = float(row.get('news_sentiment', 0))
    features['odds_h'] = float(row.get('odds_home') or 1.5)
    features['odds_a'] = float(row.get('odds_away') or 1.5)
    features['temp'] = float(row.get('weather_temp') or 20.0)
    
    # 8. Fatigue & Readiness
    features['rest_h'] = float(row.get('days_since_last_match_home') or 7)
    features['rest_a'] = float(row.get('days_since_last_match_away') or 7)
    
    h_team = str(row.get('homeTeam') or '')
    a_team = str(row.get('awayTeam') or '')
    features['travel_f'] = calculate_travel_fatigue(h_team, a_team) if h_team and a_team else 0.0
    features['is_cup'] = 1.0 if any(x in str(row.get('tournament_name','')).lower() for x in ['cup', 'coupe', 'pokal', 'copa', 'trophy']) else 0.0
    
    # [V102] Derby Awareness
    features['is_derby'] = 1.0 if is_derby_match(h_team, a_team) else 0.0

    # 9. V46 News Intelligence (Deep Parsing)
    news = row.get('news_data') or {}
    if isinstance(news, str):
        try: news = json.loads(news)
        except: news = {}
    h_intel = (news.get('home') or {}).get('intelligence', {}).get('features', {})
    a_intel = (news.get('away') or {}).get('intelligence', {}).get('features', {})
    
    features['news_is_missing_gk'] = float(h_intel.get('is_missing_gk', 0) - a_intel.get('is_missing_gk', 0))
    features['news_is_missing_scorer'] = float(h_intel.get('is_missing_scorer', 0) - a_intel.get('is_missing_scorer', 0))
    features['news_is_missing_captain'] = float(h_intel.get('is_missing_captain', 0) - a_intel.get('is_missing_captain', 0))
    features['news_is_missing_star'] = float(h_intel.get('is_missing_star', 0) - a_intel.get('is_missing_star', 0))

    # 10. V47 Strategic Features (Market & Psychology)
    v70 = row.get('v70_analytics') or {}
    if isinstance(v70, str):
        try: v70 = json.loads(v70)
        except: v70 = {}
    features['odds_velocity'] = _f((v70.get('odds_velocity') or {}).get('velocity_h'), 0)
    features['h_mkt_val'] = _f(row.get('home_market_value'), 50.0)
    features['a_mkt_val'] = _f(row.get('away_market_value'), 50.0)
    features['ref_bias'] = _f(row.get('referee_home_win_rate'), 0.45)
    features['is_pressure'] = _f(row.get('is_high_pressure'), 0)

    # 10.1 Titanium AI Pipeline (Environmental + Form Points)
    features['h_pts'] = _f(row.get('home_form_pts'), 0.0)
    features['a_pts'] = _f(row.get('away_form_pts'), 0.0)
    features['pts_diff'] = features['h_pts'] - features['a_pts']
    
    features['humidity'] = _f(row.get('weather_humidity'), 50.0)
    features['temp'] = _f(row.get('weather_temp'), 20.0)
    
    # Odds Implied Probabilities
    oh = float(row.get('odds_home') or row.get('odds_h') or 2.5)
    od = float(row.get('odds_draw') or 3.2)
    oa = float(row.get('odds_away') or row.get('odds_a') or 2.8)
    
    ipH = 1.0 / oh if oh > 0 else 0.33
    ipD = 1.0 / od if od > 0 else 0.33
    ipA = 1.0 / oa if oa > 0 else 0.33
    
    total_ip = ipH + ipD + ipA
    features['ip_h'] = ipH / total_ip
    features['ip_d'] = ipD / total_ip
    features['ip_a'] = ipA / total_ip
    
    temp = float(row.get('weather_temp') or 20.0)
    w_desc = str(row.get('weather_desc','')).lower()
    features['is_extreme_weather'] = 1.0 if (temp > 35 or temp < 5 or "heavy" in w_desc or "rain" in w_desc or "snow" in w_desc) else 0.0

    # --- V26 ELITE INTELLIGENCE ADDITIONS ---
    graph = row.get('match_graph')
    if isinstance(graph, str):
        try: graph = json.loads(graph)
        except: graph = {}
    
    h_mom, a_mom, mom_trend = calculate_momentum_trend(graph)
    features['v26_momentum_h'] = h_mom
    features['v26_momentum_a'] = a_mom
    features['v26_momentum_trend'] = mom_trend
    features['v26_lineups_confirmed'] = 1.0 if row.get('lineups_confirmed') else 0.0

    # [BOOST] V90 EXPLOSIVE MOMENTUM: Detects if a team is accelerating their performance
    h_accel = h_roll_p3 - calculate_rolling_averages(h_hist[3:6] if len(h_hist) >= 6 else [])[1]
    a_accel = a_roll_p3 - calculate_rolling_averages(a_hist[3:6] if len(a_hist) >= 6 else [])[1]
    features['explosive_momentum_h'] = h_accel if h_accel > 0 else 0.0
    features['explosive_momentum_a'] = a_accel if a_accel > 0 else 0.0

    # --- V27 TACTICAL PRECISION (Phase 7) ---
    features['ref_yellow_avg'] = float(row.get('referee_yellow_avg') or 3.8)
    features['ref_red_avg'] = float(row.get('referee_red_avg') or 0.15)
    features['ref_pen_avg'] = float(row.get('referee_penalties_avg') or 0.25)
    
    # [V55] Environmental Impact Scaling
    w_impact = 1.0
    w_desc = str(row.get('weather_desc','')).lower()
    temp = float(row.get('weather_temp') or 20.0)
    
    if 'rain' in w_desc or 'pluie' in w_desc: w_impact += 0.1
    if temp > 32: w_impact += 0.15
    if 'snow' in w_desc or 'neige' in w_desc: w_impact += 0.2
    
    features['weather_impact'] = w_impact
    
    # 11. [V51] REAL H2H INTELLIGENCE (Sofascore Integration)
    h2h = row.get('h2h_data')
    if isinstance(h2h, str):
        try: h2h = json.loads(h2h)
        except: h2h = {}
    if not isinstance(h2h, dict):
        h2h = {}
    
    duel = h2h.get('teamDuel', {})
    h2_h_w = float(duel.get('homeWins', 0))
    h2_a_w = float(duel.get('awayWins', 0))
    h2_d = float(duel.get('draws', 0))
    h2_total = h2_h_w + h2_a_w + h2_d
    
    features['h2h_home_win_rate'] = h2_h_w / h2_total if h2_total > 0 else 0.33
    features['h2h_away_win_rate'] = h2_a_w / h2_total if h2_total > 0 else 0.33
    features['h2h_draw_rate'] = h2_d / h2_total if h2_total > 0 else 0.34
    features['h2h_total_matches'] = h2_total

    # 12. [V52] LINE MOVEMENT INTELLIGENCE (24h Market Delta)
    move = row.get('odds_movement_24h') or {}
    if isinstance(move, str):
        try: move = json.loads(move)
        except: move = {}
    if not isinstance(move, dict):
        move = {}
    
    features['h_odds_move_24h'] = float(move.get('h_pct', 0))
    features['a_odds_move_24h'] = float(move.get('a_pct', 0))
    features['d_odds_move_24h'] = float(move.get('d_pct', 0))
    features['market_reliability'] = 1.0 if move.get('is_reliable') else 0.0

    # [V95] ODDS ACCELERATION: Detects rapid changes in the last hour
    move_1h = row.get('odds_movement_1h') or {}
    if isinstance(move_1h, str):
        try: move_1h = json.loads(move_1h)
        except: move_1h = {}
    
    h_accel = float(move_1h.get('h_pct', 0))
    a_accel = float(move_1h.get('a_pct', 0))
    # If 1h movement is faster than 24h movement (normalized), acceleration is high
    features['odds_acceleration_h'] = h_accel if abs(h_accel) > abs(features['h_odds_move_24h'] / 24) else 0.0
    features['odds_acceleration_a'] = a_accel if abs(a_accel) > abs(features['a_odds_move_24h'] / 24) else 0.0


    # Existing V25 indicators (syncing with V26/V27)
    mot_val, _ = get_match_motivation_context(row)
    volume = float(row.get('market_volume') or 50000.0)
    features['motivation_context'] = mot_val
    features['liquidity_index'] = min(1.0, volume / 100000.0)
    features['data_completeness'] = calculate_data_completeness(features)

    # --- V53 ENHANCED FEATURES (xGA, xPTS, Efficiency, Streaks, H2H Advanced, Bayesian) ---

    # 1. xGA (Expected Goals Against) — avg opponent xG in recent matches (time-decayed)
    h_xga_val = _get_decayed_avg(h_hist, 'Expected goals_away', ts_h, 'goalsAgainst', 1.2)
    a_xga_val = _get_decayed_avg(a_hist, 'Expected goals_away', ts_a, 'goalsAgainst', 1.2)
    features['h_xga'] = h_xga_val
    features['a_xga'] = a_xga_val
    features['xga_diff'] = h_xga_val - a_xga_val

    # 2. xG Overperformance (actual goals - xG) — >0 = regression to come (time-decayed)
    h_xg_avg = _get_decayed_avg(h_hist, 'Expected goals_home', ts_h, 'expectedGoals', 1.0)
    a_xg_avg = _get_decayed_avg(a_hist, 'Expected goals_home', ts_a, 'expectedGoals', 1.0)
    h_goals_avg = _get_decayed_avg(h_hist, 'score_for', ts_h, 'avgGoals', 1.2)
    a_goals_avg = _get_decayed_avg(a_hist, 'score_for', ts_a, 'avgGoals', 1.2)
    features['h_xg_overperformance'] = h_goals_avg - h_xg_avg
    features['a_xg_overperformance'] = a_goals_avg - a_xg_avg

    # 3. xPTS (Expected Points proxy) — from xG_diff converted to expected win/draw/loss
    def _xpts_proxy(team_xg, opp_xg):
        if team_xg + opp_xg == 0: return 1.0
        p_win = team_xg / (team_xg + opp_xg) * 0.6
        p_draw = 0.25
        return p_win * 3.0 + p_draw * 1.0

    features['h_xpts'] = _xpts_proxy(features['h_xg'], features['a_xg'])
    features['a_xpts'] = _xpts_proxy(features['a_xg'], features['h_xg'])

    # 4. Conversion & Efficiency
    features['h_conversion_rate'] = _hist_rate(h_hist, 'score_for', 'Total shots_home', 0.1)
    features['a_conversion_rate'] = _hist_rate(a_hist, 'score_for', 'Total shots_away', 0.1)
    features['h_sot_rate'] = _hist_rate(h_hist, 'Shots on target_home', 'Total shots_home', 0.4)
    features['a_sot_rate'] = _hist_rate(a_hist, 'Shots on target_away', 'Total shots_away', 0.4)
    h_shots_vol = _get_decayed_avg(h_hist, 'Total shots_home', ts_h, 'avgShots', 10.0)
    a_shots_vol = _get_decayed_avg(a_hist, 'Total shots_away', ts_a, 'avgShots', 10.0)
    features['h_shot_volume'] = h_shots_vol
    features['a_shot_volume'] = a_shots_vol

    # 5. Streaks (momentum)
    features['h_clean_streak'] = _compute_streak(h_hist, lambda m: m.get('score_against', 0) == 0)
    features['a_clean_streak'] = _compute_streak(a_hist, lambda m: m.get('score_against', 0) == 0)
    features['h_scoring_streak'] = _compute_streak(h_hist, lambda m: m.get('score_for', 0) > 0)
    features['a_scoring_streak'] = _compute_streak(a_hist, lambda m: m.get('score_for', 0) > 0)
    features['h_win_streak'] = _compute_streak(h_hist, lambda m: m.get('points', 0) == 3)
    features['a_win_streak'] = _compute_streak(a_hist, lambda m: m.get('points', 0) == 3)

    # 6. H2H Advanced (from archive)
    h2h_adv = get_h2h_advanced(home_name, away_name, current_match_ts)
    features['h2h_avg_goals'] = h2h_adv.get('avg_total_goals', 0.0)
    features['h2h_over25_rate'] = h2h_adv.get('over25_rate', 0.5)
    features['h2h_avg_xg'] = h2h_adv.get('avg_xg', 0.0)
    features['h2h_archive_matches'] = float(h2h_adv.get('total_matches', 0))

    # 7. Bayesian Shrink Factors (weight by sample size)
    h_shrink = min(1.0, len(h_hist) / 10.0)
    a_shrink = min(1.0, len(a_hist) / 10.0)
    features['h_shrink_factor'] = h_shrink
    features['a_shrink_factor'] = a_shrink

    # 8. Time context
    ts = row.get('startTimestamp') or row.get('match_date') or 0
    try:
        ts = int(ts)
        import datetime
        dt = datetime.datetime.fromtimestamp(ts)
        features['day_of_week'] = float(dt.weekday())
        features['kickoff_hour'] = float(dt.hour)
    except:
        features['day_of_week'] = -1.0
        features['kickoff_hour'] = -1.0

    # 9. Enhanced match importance
    imp_score = features.get('motivation_context', 1.0)
    if features.get('is_cup', 0) > 0: imp_score += 0.3
    if abs(features.get('pts_diff', 0)) < 0.5 and features.get('h_pts', 0) > 0: imp_score += 0.2
    features['match_importance'] = imp_score

    # 10. Tunisia Crowdsourcing Features (TITANIUM V3)
    tn_features = extract_tunisian_features(home_name, away_name)
    features.update(tn_features)

    # 10b. Raw Promosport vote percentages (from match data)
    vh = _f(row.get('vote_home'), -1)
    vd = _f(row.get('vote_draw'), -1)
    va = _f(row.get('vote_away'), -1)
    if vh >= 0 and vd >= 0 and va >= 0:
        total = vh + vd + va
        features['vote_home_pct'] = vh / total if total > 0 else 0.5
        features['vote_draw_pct'] = vd / total if total > 0 else 0.33
        features['vote_away_pct'] = va / total if total > 0 else 0.17
        features['vote_advantage_home'] = vh - va
        features['vote_home_norm'] = features['vote_home_pct']
    else:
        features['vote_home_pct'] = 0.5
        features['vote_draw_pct'] = 0.33
        features['vote_away_pct'] = 0.17
        features['vote_advantage_home'] = 0.0
        features['vote_home_norm'] = 0.5

    # --- V55 FEATURE CROSSES & COMPOSITE METRICS ---
    def _safe_div(a, b):
        return a / b if b and b != 0 else 0.0

    # xG per shot — shot quality indicator
    features['xg_per_shot_h'] = _safe_div(features.get('h_xg', 0), features.get('h_shot_volume', 1))
    features['xg_per_shot_a'] = _safe_div(features.get('a_xg', 0), features.get('a_shot_volume', 1))

    # SoT per possession — attacking intensity
    features['sot_per_possession_h'] = _safe_div(features.get('h_sot', 1), features.get('h_pos', 50))
    features['sot_per_possession_a'] = _safe_div(features.get('a_sot', 1), features.get('a_pos', 50))

    # Goals per xG — finishing efficiency (regression signal)
    h_goals_avg = _get_decayed_avg(h_hist, 'score_for', ts_h, 'avgGoals', 1.2)
    a_goals_avg = _get_decayed_avg(a_hist, 'score_for', ts_a, 'avgGoals', 1.2)
    features['goals_per_xg_h'] = _safe_div(h_goals_avg, features.get('h_xg', 1))
    features['goals_per_xg_a'] = _safe_div(a_goals_avg, features.get('a_xg', 1))

    # SoT conceded per possession — defensive pressure resistance
    features['sot_conceded_per_possession_h'] = _safe_div(features.get('h_sot_faced', 1), features.get('h_pos', 50))
    features['sot_conceded_per_possession_a'] = _safe_div(features.get('a_sot_faced', 1), features.get('a_pos', 50))

    # Shots faced per xG conceded — opponent chance quality
    features['shots_faced_per_xg_h'] = _safe_div(features.get('h_shots_faced', 1), features.get('h_xga', 1))
    features['shots_faced_per_xg_a'] = _safe_div(features.get('a_shots_faced', 1), features.get('a_xga', 1))


    # Form × Momentum interaction
    features['form_x_momentum_h'] = features.get('home_momentum_points', 0) * features.get('explosive_momentum_h', 0)
    features['form_x_momentum_a'] = features.get('away_momentum_points', 0) * features.get('explosive_momentum_a', 0)

    # Elo × Home advantage interaction
    is_home_stronger = 1.0 if features.get('elo_diff', 0) > 50 else 0.0
    features['elo_x_home_advantage'] = 1.0 if is_home_stronger > 0 else 0.0

    # Odds-implied probability minus xG-derived probability (market mispricing)
    odds_implied_h = features.get('ip_h', 0.33)
    odds_implied_a = features.get('ip_a', 0.33)
    xg_implied_h = _safe_div(features.get('h_xg', 1), features.get('h_xg', 1) + features.get('a_xg', 1)) if features.get('h_xg', 0) + features.get('a_xg', 0) > 0 else 0.5
    xg_implied_a = 1.0 - xg_implied_h
    features['odds_implied_minus_xg_prob_h'] = odds_implied_h - xg_implied_h
    features['odds_implied_minus_xg_prob_a'] = odds_implied_a - xg_implied_a

    # Sharp money × odds movement interaction
    features['sharp_money_x_odds_move_h'] = features.get('ta_sharp_money_h', 0) * features.get('h_odds_move_24h', 0)
    features['sharp_money_x_odds_move_a'] = features.get('ta_sharp_money_a', 0) * features.get('a_odds_move_24h', 0)

    # Cyclical time encoding
    try:
        ts = int(row.get('startTimestamp') or row.get('match_date') or 0)
        import datetime
        dt = datetime.datetime.fromtimestamp(ts)
        features['day_sin'] = float(math.sin(2 * math.pi * dt.weekday() / 7))
        features['day_cos'] = float(math.cos(2 * math.pi * dt.weekday() / 7))
        features['month_sin'] = float(math.sin(2 * math.pi * (dt.month - 1) / 12))
        features['month_cos'] = float(math.cos(2 * math.pi * (dt.month - 1) / 12))
    except:
        features['day_sin'] = 0.0
        features['day_cos'] = 0.0
        features['month_sin'] = 0.0
        features['month_cos'] = 0.0

    # Data quality flags
    features['has_actual_xg'] = 1.0 if (float(row.get('home_xg') or 0) > 0 or float(row.get('away_xg') or 0) > 0 or float(row.get('home_shots_on_goal') or 0) > 0 or float(row.get('away_shots_on_goal') or 0) > 0) else 0.0
    features['has_actual_odds'] = 1.0 if (float(row.get('odds_home') or 0) > 1.0 and float(row.get('odds_away') or 0) > 1.0) else 0.0
    features['has_match_stats'] = 1.0 if (features.get('h_pos', 0) > 0 or features.get('a_pos', 0) > 0) else 0.0
    try:
        match_year = int(dt.year)
        features['is_modern_football_era'] = 1.0 if match_year >= 2015 else 0.0
    except:
        features['is_modern_football_era'] = 1.0
    features['data_completeness_score'] = features.get('data_completeness', 0.5)

    # --- V553 WC2026-SPECIFIC FEATURES ---
    wc26_teams = get_wc2026_team_data()
    h_name_key = h_team.strip().lower() if h_team else ''
    a_name_key = a_team.strip().lower() if a_team else ''
    h_wc = wc26_teams.get(h_name_key, {})
    a_wc = wc26_teams.get(a_name_key, {})
    features['fifa_rank_h'] = h_wc.get('fifa_rank', 999)
    features['fifa_rank_a'] = a_wc.get('fifa_rank', 999)
    features['fifa_pts_h'] = h_wc.get('fifa_points', 0)
    features['fifa_pts_a'] = a_wc.get('fifa_points', 0)
    features['squad_value_h'] = h_wc.get('squad_value', 0)
    features['squad_value_a'] = a_wc.get('squad_value', 0)
    features['squad_size_h'] = h_wc.get('squad_size', 26)
    features['squad_size_a'] = a_wc.get('squad_size', 26)
    features['avg_age_h'] = h_wc.get('avg_age', 27)
    features['avg_age_a'] = a_wc.get('avg_age', 27)
    features['fifa_rank_diff'] = features['fifa_rank_h'] - features['fifa_rank_a']
    features['squad_value_diff'] = features['squad_value_h'] - features['squad_value_a']
    conf_h = (h_wc.get('confederation') or '').upper()
    conf_a = (a_wc.get('confederation') or '').upper()
    features['conf_uefa_h'] = 1.0 if conf_h == 'UEFA' else 0.0
    features['conf_conmebol_h'] = 1.0 if conf_h == 'CONMEBOL' else 0.0
    features['conf_uefa_a'] = 1.0 if conf_a == 'UEFA' else 0.0
    features['conf_conmebol_a'] = 1.0 if conf_a == 'CONMEBOL' else 0.0

    # --- [DPM-LIGHT] Draw Pattern Features (Deadlock + Defensive Equilibrium) ---
    if h_hist and a_hist:
        h_cs = sum(1 for m in h_hist if m.get('score_against', 1) == 0) / max(len(h_hist), 1)
        a_cs = sum(1 for m in a_hist if m.get('score_against', 1) == 0) / max(len(a_hist), 1)
        h_ga = sum(m.get('score_against', 0) for m in h_hist) / max(len(h_hist), 1)
        a_ga = sum(m.get('score_against', 0) for m in a_hist) / max(len(a_hist), 1)
        h_gf = sum(m.get('score_for', 0) for m in h_hist) / max(len(h_hist), 1)
        a_gf = sum(m.get('score_for', 0) for m in a_hist) / max(len(a_hist), 1)

        deadlock_ga = (h_ga + a_ga) / 2.0
        cs_avg = (h_cs + a_cs) / 2.0
        if cs_avg > 0.30 and deadlock_ga < 1.5:
            features['draw_deadlock'] = min(1.0, max(0.0, (1.5 - deadlock_ga) * cs_avg * 2.0))
        else:
            features['draw_deadlock'] = 0.0

        eq_h = abs(h_gf - a_ga)
        eq_a = abs(a_gf - h_ga)
        eq_raw = (eq_h + eq_a) / 2.0
        features['draw_defensive_eq'] = max(0.0, min(1.0, 1.0 - eq_raw * 0.35))
    else:
        features['draw_deadlock'] = 0.0
        features['draw_defensive_eq'] = 0.0

    # --- V52 STABILITY GUARD: Final NaN/None Cleanup ---
    for k, v in list(features.items()):
        if v is None or (isinstance(v, float) and math.isnan(v)):
            features[k] = 0.0
        else:
            try:
                features[k] = float(v)
            except (ValueError, TypeError):
                features[k] = 0.0

    # --- GNN-lite Graph Features (transitive strength, PageRank, community) ---
    try:
        from graph_engine import compute_graph_features, GRAPH_FEATURE_NAMES
        graph_feats = compute_graph_features(home_name, away_name, _league_name)
        features.update(graph_feats)
    except Exception:
        for fn in GRAPH_FEATURE_NAMES:
            features.setdefault(fn, 0.0)

    # --- DEX Prediction Markets (smart money flow, Polymarket/Azuro) ---
    try:
        from dex_tracker import compute_dex_signals, DEX_FEATURE_NAMES
        dex_feats = compute_dex_signals(
            home_name, away_name,
            odds_home=_f(row.get('odds_home'), 0),
            odds_draw=_f(row.get('odds_draw'), 0),
            odds_away=_f(row.get('odds_away'), 0),
        )
        features.update(dex_feats)
    except Exception:
        for fn in DEX_FEATURE_NAMES:
            features.setdefault(fn, 0.0)

    return features

# V23 Feature Names — Used by the existing trained model (stitch_v23_hybrid.json)
# DO NOT MODIFY: changing this list breaks XGBoost inference.
FEATURE_NAMES = [
    'home_elo', 'away_elo', 'elo_diff', 'home_motivation', 'away_motivation',
    'tactical_synergy', 'home_injury_impact', 'away_injury_impact',
    'h_pos', 'a_pos', 'pos_diff', 'h_pass_acc', 'a_pass_acc', 'pass_acc_diff',
    'h_xg', 'a_xg', 'xg_diff', 'h_bc', 'a_bc', 'bc_diff',
    'h_sot', 'a_sot', 'sot_diff', 'h_shots_off', 'a_shots_off', 'h_inner_shots', 'a_inner_shots',
    'h_int', 'a_int', 'int_diff', 'h_tackles', 'a_tackles', 'tackles_diff',
    'h_clear', 'a_clear', 'clear_diff', 'h_def_err', 'a_def_err', 'h_saves', 'a_saves',
    'h_ground_won', 'a_ground_won', 'h_aerial_won', 'a_aerial_won',
    'h_poss_lost', 'a_poss_lost', 'lost_diff', 'h_corners', 'a_corners', 'corner_diff',
    'h_fouls', 'a_fouls', 'foul_diff', 'h_cards', 'a_cards',
    'h_style_enc', 'a_style_enc', 'h_mom_gicko', 'a_mom_gicko',
    'h_att_imp', 'a_att_imp', 'news_sent', 'odds_h', 'odds_a', 'temp',
    'rest_h', 'rest_a', 'travel_f', 'is_cup'
]

# V24 Extended Feature Names — For future retraining with Top Analyst Market Intelligence.
# Use this list when training stitch_v24 or later models.
FEATURE_NAMES_V24 = FEATURE_NAMES + [
    # Top Analyst Engine Features (Sharp Money + Market Intelligence)
    'ta_true_prob_h', 'ta_true_prob_d', 'ta_true_prob_a',
    'ta_odds_change_speed_h', 'ta_odds_change_speed_a',
    'ta_sharp_money_h', 'ta_sharp_money_a', 'ta_sharp_money_d',
    'ta_sharp_money_indicator',
    'ta_xg_h', 'ta_xg_a',
    'ta_sot_h', 'ta_sot_a',
    'ta_news_impact', 'ta_news_sentiment',
    'ta_over_25_prob', 'ta_under_25_prob', 'ta_expected_total_goals',
    'ta_value_bet_flag', 'ta_highest_value_index',
    'ta_market_confidence_indicator', 'ta_team_strength_indicator',
    'ta_momentum_indicator', 'ta_goal_expectation_indicator',
    'ta_h_rating', 'ta_a_rating', 'ta_rating_diff'
]

# V25 Intelligence Feature Names — Adding Context & Reliability
FEATURE_NAMES_V25 = FEATURE_NAMES_V24 + [
    'motivation_context',
    'liquidity_index',
    'data_completeness'
]

# V26 Elite Intelligence Guard — Real-time Verification
FEATURE_NAMES_V26 = FEATURE_NAMES_V25 + [
    'v26_momentum_h',
    'v26_momentum_a',
    'v26_momentum_trend',
    'v26_lineups_confirmed'
]
# V27 Tactical Precision Feature Names (Phase 7)
FEATURE_NAMES_V27 = FEATURE_NAMES_V26 + [
    'ref_yellow_avg',
    'ref_red_avg',
    'ref_pen_avg',
    'weather_impact'
]

# V51 Real H2H Intelligence (Sofascore Integration)
FEATURE_NAMES_V51 = FEATURE_NAMES_V27 + [
    'h2h_home_win_rate',
    'h2h_away_win_rate',
    'h2h_draw_rate',
    'h2h_total_matches'
]

# V52 Line Movement Intelligence (Market Psychology)
FEATURE_NAMES_V52 = FEATURE_NAMES_V51 + [
    'h_odds_move_24h',
    'a_odds_move_24h',
    'd_odds_move_24h',
    'market_reliability'
]

# V53 Enhanced Features (xGA, xPTS, Efficiency, Streaks, H2H Advanced, Bayesian Shrink)
FEATURE_NAMES_V53 = FEATURE_NAMES_V52 + [
    'h_xga', 'a_xga', 'xga_diff',
    'h_xg_overperformance', 'a_xg_overperformance',
    'h_xpts', 'a_xpts',
    'h_conversion_rate', 'a_conversion_rate',
    'h_sot_rate', 'a_sot_rate',
    'h_shot_volume', 'a_shot_volume',
    'h_clean_streak', 'a_clean_streak',
    'h_scoring_streak', 'a_scoring_streak',
    'h_win_streak', 'a_win_streak',
    'h2h_avg_goals', 'h2h_over25_rate', 'h2h_avg_xg', 'h2h_archive_matches',
    'h_shrink_factor', 'a_shrink_factor',
    'day_of_week', 'kickoff_hour',
    'match_importance',
    'h_successful_dribbles', 'a_successful_dribbles',
    'h_accurate_long_balls', 'a_accurate_long_balls',
    'h_accurate_crosses', 'a_accurate_crosses',
    'h_opp_half_passes', 'a_opp_half_passes',
    'h_duels_won_pct', 'a_duels_won_pct',
    'h_accurate_opp_half_passes', 'a_accurate_opp_half_passes',
    'h_acc_own_half_passes', 'a_acc_own_half_passes',
    'h_long_ball_pct', 'a_long_ball_pct',
    'h_cross_pct', 'a_cross_pct',
    'h_ground_duels', 'a_ground_duels',
    'h_aerial_duel_pct', 'a_aerial_duel_pct',
    'h_total_duels', 'a_total_duels',
    'h_ball_recovery', 'a_ball_recovery',
    'h_blocked_shots', 'a_blocked_shots',
    'h_assists', 'a_assists',
    'h_shots_sot_faced', 'a_shots_sot_faced',
    'h_bc_conceded', 'a_bc_conceded',
    'h_ppda', 'a_ppda',
    'h_prog_passes', 'a_prog_passes',
    'h_sca', 'a_sca',
    'h_xg_per_shot', 'a_xg_per_shot',
    'h_sot_per_possession', 'a_sot_per_possession',
    'h_goals_per_xg', 'a_goals_per_xg',
    'h_elo_x_home_advantage', 'a_elo_x_home_advantage',
    'h_sharp_money_x_odds_move', 'a_sharp_money_x_odds_move'
]

# V54 FBref + Cross Features
FEATURE_NAMES_V54 = FEATURE_NAMES_V53 + [
    'h_sin_day', 'a_sin_day', 'h_cos_day', 'a_cos_day',
    'h_sin_month', 'a_sin_month', 'h_cos_month', 'a_cos_month',
    'h_data_quality_gate', 'a_data_quality_gate',
    'h_implied_prob_h', 'a_implied_prob_h',
    'h_implied_prob_d', 'a_implied_prob_d',
    'h_implied_prob_a', 'a_implied_prob_a'
]

# V55 Bayesian Shrinkage + Football Efficiency Crosses
FEATURE_NAMES_V55 = FEATURE_NAMES_V54 + [
    'h_bayesian_shrink', 'a_bayesian_shrink',
    'h_day_sin', 'a_day_sin', 'h_day_cos', 'a_day_cos',
    'h_month_sin', 'a_month_sin', 'h_month_cos', 'a_month_cos',
    'h_is_derby', 'a_is_derby',
    'h_news_missing_gk', 'a_news_missing_gk',
    'h_news_missing_scorer', 'a_news_missing_scorer',
    'h_news_missing_captain', 'a_news_missing_captain',
    'h_news_missing_star', 'a_news_missing_star'
]

# V551 Pruned Features
FEATURE_NAMES_V551 = FEATURE_NAMES_V55 + [
    'h_xg_per_shot', 'a_xg_per_shot'
]

# V552 Draw Deadlock
FEATURE_NAMES_V552 = FEATURE_NAMES_V551 + [
    'h_draw_deadlock', 'a_draw_deadlock'
]

# V553 WC2026 Context
FEATURE_NAMES_V553 = FEATURE_NAMES_V552 + [
    'h_fifa_rank', 'a_fifa_rank', 'fifa_rank_diff',
    'h_fifa_pts', 'a_fifa_pts', 'fifa_pts_diff',
    'h_fifa_confederation', 'a_fifa_confederation',
    'h_squad_value', 'a_squad_value', 'squad_value_diff',
    'h_squad_size', 'a_squad_size', 'squad_size_diff',
    'h_squad_age_avg', 'a_squad_age_avg', 'squad_age_avg_diff'
]

# V56 Auto-Retrain Set (30 features)
FEATURE_NAMES_V56 = [
    # 10 Base Stats Diffs
    'h_pos_diff', 'a_pos_diff',
    'h_xg_diff', 'a_xg_diff',
    'h_sot_diff', 'a_sot_diff',
    'h_bc_diff', 'a_bc_diff',
    'h_corners_diff', 'a_corners_diff',
    # 4 Ratings
    'h_rating_diff', 'a_rating_diff',
    # 8 Form/H2H
    'h_last5_win', 'a_last5_win',
    'h_last5_draw', 'a_last5_draw',
    'h_last5_loss', 'a_last5_loss',
    'h2h_homes', 'h2h_aways',
    # 4 Efficiency
    'h_xg_per_shot_diff', 'a_xg_per_shot_diff',
    'h_sot_per_poss_diff', 'a_sot_per_poss_diff',
    'h_goals_per_xg_diff', 'a_goals_per_xg_diff',
    # 4 Temporal
    'h_rest_days_diff', 'a_rest_days_diff',
    'h_travel_km', 'a_travel_km',
    'h_time_diff_hours', 'a_time_diff_hours',
    'h_home_field_adv_diff', 'a_home_field_adv_diff'
]

# TITANIUM V3 Elite Features (V54 + Tunisia Specific)
FEATURE_NAMES_TITANIUM = FEATURE_NAMES_V54 + [
    'h_pts', 'a_pts', 'pts_diff',
    'humidity',
    'ip_h', 'ip_d', 'ip_a',
    'is_extreme_weather',
    'news_is_missing_gk', 'news_is_missing_scorer', 'news_is_missing_captain', 'news_is_missing_star',
    'odds_velocity', 'is_derby',
    # Tunisia Specific Features
    'h_tn_vote_consent', 'a_tn_vote_consent', 'tn_vote_consent_diff',
    'h_tn_vote_sentiment', 'a_tn_vote_sentiment', 'tn_vote_sentiment_diff',
    'h_tn_vote_divergence', 'a_tn_vote_divergence', 'tn_vote_divergence_diff',
    'h_tn_vote_volatility', 'a_tn_vote_volatility', 'tn_vote_volatility_diff',
    'h_tn_jackpot_pressure', 'a_tn_jackpot_pressure', 'tn_jackpot_pressure_diff',
    'h_tn_crowd_conviction', 'a_tn_crowd_conviction', 'tn_crowd_conviction_diff'
]

# V52 Line Movement Intelligence (Market Psychology)
FEATURE_NAMES_V52 = FEATURE_NAMES_V51 + [
    'h_odds_move_24h',
    'a_odds_move_24h',
    'd_odds_move_24h',
    'market_reliability'
]

# V53 Enhanced Features (xGA, xPTS, Efficiency, Streaks, H2H Advanced, Bayesian Shrink)
FEATURE_NAMES_V53 = FEATURE_NAMES_V52 + [
    'h_xga', 'a_xga', 'xga_diff',
    'h_xg_overperformance', 'a_xg_overperformance',
    'h_xpts', 'a_xpts',
    'h_conversion_rate', 'a_conversion_rate',
    'h_sot_rate', 'a_sot_rate',
    'h_shot_volume', 'a_shot_volume',
    'h_clean_streak', 'a_clean_streak',
    'h_scoring_streak', 'a_scoring_streak',
    'h_win_streak', 'a_win_streak',
    'h2h_avg_goals', 'h2h_over25_rate', 'h2h_avg_xg', 'h2h_archive_matches',
    'h_shrink_factor', 'a_shrink_factor',
    'day_of_week', 'kickoff_hour',
    'match_importance',
    'h_successful_dribbles', 'a_successful_dribbles',
    'h_accurate_long_balls', 'a_accurate_long_balls',
    'h_accurate_crosses', 'a_accurate_crosses',
    'h_opp_half_passes', 'a_opp_half_passes',
    'h_duels_won_pct', 'a_duels_won_pct',
    'h_errors_leading_to_shot', 'a_errors_leading_to_shot'
]

# V54 Enhanced Passing, Duels, Defensive (Against) + FBref Proxies
FEATURE_NAMES_V54 = FEATURE_NAMES_V53 + [
    'h_accurate_opp_half_passes', 'a_accurate_opp_half_passes',
    'h_opp_half_pass_pct', 'a_opp_half_pass_pct',
    'h_acc_own_half_passes', 'a_acc_own_half_passes',
    'h_long_ball_pct', 'a_long_ball_pct',
    'h_cross_pct', 'a_cross_pct',
    'h_ground_duels_won', 'a_ground_duels_won',
    'h_ground_duel_pct', 'a_ground_duel_pct',
    'h_aerial_duel_pct', 'a_aerial_duel_pct',
    'h_total_duels', 'a_total_duels',
    'h_ball_recovery', 'a_ball_recovery',
    'h_blocked_shots', 'a_blocked_shots',
    'h_assists', 'a_assists',
    'h_shots_faced', 'a_shots_faced',
    'h_sot_faced', 'a_sot_faced',
    'h_bc_conceded', 'a_bc_conceded',
    'h_key_passes_allowed', 'a_key_passes_allowed',
    'h_corners_conceded', 'a_corners_conceded',
    'h_dribbles_allowed', 'a_dribbles_allowed',
    'h_ppda', 'a_ppda',
    'h_prog_passes', 'a_prog_passes',
    'h_sca', 'a_sca'
]

# V55 Feature Crosses & Data Quality (Composite Intelligence)
FEATURE_NAMES_V55 = FEATURE_NAMES_V54 + [
    # xG per shot — shot quality
    'xg_per_shot_h', 'xg_per_shot_a',
    # SoT per possession — attacking intensity
    'sot_per_possession_h', 'sot_per_possession_a',
    # Goals per xG — finishing efficiency (regression towards mean)
    'goals_per_xg_h', 'goals_per_xg_a',
    # SoT conceded per possession — defensive discipline
    'sot_conceded_per_possession_h', 'sot_conceded_per_possession_a',
    # Shots faced per xG conceded — defensive quality
    'shots_faced_per_xg_h', 'shots_faced_per_xg_a',
    # Form × Momentum cross
    'form_x_momentum_h', 'form_x_momentum_a',
    # Elo × Home advantage
    'elo_x_home_advantage',
    # Market mispricing (odds implied - xG implied)
    'odds_implied_minus_xg_prob_h', 'odds_implied_minus_xg_prob_a',
    # Sharp money × odds movement
    'sharp_money_x_odds_move_h', 'sharp_money_x_odds_move_a',
    # Cyclical time encoding
    'day_sin', 'day_cos', 'month_sin', 'month_cos',
    # Data quality gates
    'has_actual_xg', 'has_actual_odds', 'has_match_stats',
    'is_modern_football_era', 'data_completeness_score'
]

# V56 — Auto-Retrain Feature Set: simple match stats + form + H2H
# Designed for weekly auto-retrain from soccer_fixtures + soccer_match_stats
FEATURE_NAMES_V56 = [
    # Base stats (10)
    'pos_diff',
    'shots_diff',
    'sot_diff',
    'corners_diff',
    'fouls_diff',
    'yellow_diff',
    'red_diff',
    'inside_box_shots_diff',
    'xg_diff',
    'xg_per_shot_diff',
    # Team ratings (4)
    'home_attack_rating',
    'home_defense_rating',
    'attack_x_defense',
    'odds_ratio',
    # Form & H2H (8)
    'form_diff',
    'h2h_home_win_rate',
    'h2h_total_matches',
    'form_shots_diff',
    'form_sot_diff',
    'form_corners_diff',
    'form_poss_h',
    'form_poss_a',
    # Efficiency ratios (4)
    'sot_ratio_h',
    'sot_ratio_a',
    'possession_efficiency_h',
    'possession_efficiency_a',
    # Temporal (4)
    'month_sin',
    'month_cos',
    'home_avg_goals_scored',
    'away_avg_goals_conceded',
]


def _f(v, default=0.0):
    try:
        if v is None or str(v).lower() in ['none', 'null', '', 'nan']:
            return float(default)
        return float(v)
    except:
        return float(default)

def extract_v56_features(row_or_feats, rows=None, match_idx=None):
    """Extract V56 feature vector (30 floats matching FEATURE_NAMES_V56).

    Two modes:
    1. Training: pass raw (row, rows, match_idx) for temporal feature engineering
    2. Inference: pass features dict from extract_ml_features() as row_or_feats

    Inference mode maps from the rich features dict to V56 features.
    Training mode computes form + H2H from historical rows.
    """

    # Detect mode: if rows are provided, it's training mode (raw row)
    if rows is not None and match_idx is not None:
        row = row_or_feats
        # Base stats
        _pos_diff = _f(row.get('home_possession'), 50) - _f(row.get('away_possession'), 50)
        _shots_diff = _f(row.get('home_shots') or row.get('home_shots_total')) - _f(row.get('away_shots') or row.get('away_shots_total'))
        _sot_diff = _f(row.get('home_shots_on_goal') or row.get('home_shots_on_target')) - _f(row.get('away_shots_on_goal') or row.get('away_shots_on_target'))
        _corners_diff = _f(row.get('home_corners')) - _f(row.get('away_corners'))
        _fouls_diff = _f(row.get('home_fouls')) - _f(row.get('away_fouls'))
        _yellow_diff = _f(row.get('home_yellow_cards')) - _f(row.get('away_yellow_cards'))
        _red_diff = _f(row.get('home_red_cards')) - _f(row.get('away_red_cards'))
        _inside_box_shots_diff = _f(row.get('home_shots_inside_box')) - _f(row.get('away_shots_inside_box'))
        h_xg = _f(row.get('home_xg'), 0)
        a_xg = _f(row.get('away_xg'), 0)
        _xg_diff = h_xg - a_xg
        h_shots_total = _f(row.get('home_shots') or row.get('home_shots_total'), 1)
        a_shots_total = _f(row.get('away_shots') or row.get('away_shots_total'), 1)
        _xg_per_shot_diff = (h_xg / max(h_shots_total, 0.01)) - (a_xg / max(a_shots_total, 0.01))

        # Team ratings
        _home_attack_rating = _f(row.get('home_attack_rating'), 1.0)
        _home_defense_rating = _f(row.get('home_defense_rating'), 1.0)
        _away_attack_rating = _f(row.get('away_attack_rating'), 1.0)
        _away_defense_rating = _f(row.get('away_defense_rating'), 1.0)
        _attack_x_defense = _home_attack_rating * (1.0 / max(_away_defense_rating, 0.1))
        _odds_h = _f(row.get('odds_home'), 2.0)
        _odds_a = _f(row.get('odds_away'), 2.0)
        _odds_ratio = _odds_a / max(_odds_h, 0.01)

        # Efficiency ratios (from current match only — form versions from loops)
        h_sot_val = _f(row.get('home_shots_on_goal') or row.get('home_shots_on_target'), 0)
        a_sot_val = _f(row.get('away_shots_on_goal') or row.get('away_shots_on_target'), 0)
        h_poss_val = _f(row.get('home_possession'), 50)
        a_poss_val = _f(row.get('away_possession'), 50)
        _sot_ratio_h = h_sot_val / max(h_shots_total, 0.01)
        _sot_ratio_a = a_sot_val / max(a_shots_total, 0.01)
        _possession_efficiency_h = h_xg / max(h_poss_val / 100.0, 0.01)
        _possession_efficiency_a = a_xg / max(a_poss_val / 100.0, 0.01)

        # Form state (will be computed from historical rows)
        _form_diff = 0.0
        _h2h_win_rate = 0.0
        _h2h_total = 0
        _form_shots_diff = 0.0
        _form_sot_diff = 0.0
        _form_corners_diff = 0.0
        _form_poss_h = 50.0
        _form_poss_a = 50.0
        _home_avg_goals_scored = 0.0
        _away_avg_goals_conceded = 0.0
        _month_sin = 0.0
        _month_cos = 0.0

        if match_idx > 10:
            home_team = str(row.get('home_team', '') or row.get('homeTeam', ''))
            away_team = str(row.get('away_team', '') or row.get('awayTeam', ''))

            h_shots, a_shots = [], []
            h_sot, a_sot = [], []
            h_corners, a_corners = [], []
            h_poss, a_poss = [], []
            h_goals_scored, a_goals_scored = [], []
            h_goals_conceded, a_goals_conceded = [], []
            h_xg_list, a_xg_list = [], []
            h_wins, a_wins = 0, 0
            h_games, a_games = 0, 0
            h2h_h_wins = 0
            h2h_total = 0

            for i in range(match_idx - 1, max(-1, match_idx - 50), -1):
                r = rows[i]
                r_home = str(r.get('home_team', '') or r.get('homeTeam', ''))
                r_away = str(r.get('away_team', '') or r.get('awayTeam', ''))
                gh = _f(r.get('goals_home') or r.get('scoreHome') or r.get('score_home'))
                ga = _f(r.get('goals_away') or r.get('scoreAway') or r.get('score_away'))
                if gh + ga == 0:
                    continue

                if r_home == home_team:
                    h_shots.append(_f(r.get('home_shots') or r.get('home_shots_total')))
                    h_sot.append(_f(r.get('home_shots_on_goal') or r.get('home_shots_on_target')))
                    h_corners.append(_f(r.get('home_corners')))
                    h_poss.append(_f(r.get('home_possession'), 50))
                    h_goals_scored.append(gh)
                    h_goals_conceded.append(ga)
                    h_xg_list.append(_f(r.get('home_xg'), 0))
                    h_games += 1
                    if gh > ga: h_wins += 1
                elif r_away == home_team:
                    h_shots.append(_f(r.get('away_shots') or r.get('away_shots_total')))
                    h_sot.append(_f(r.get('away_shots_on_goal') or r.get('away_shots_on_target')))
                    h_corners.append(_f(r.get('away_corners')))
                    h_poss.append(_f(r.get('away_possession'), 50))
                    h_goals_scored.append(ga)
                    h_goals_conceded.append(gh)
                    h_xg_list.append(_f(r.get('away_xg'), 0))
                    h_games += 1
                    if ga > gh: h_wins += 1

                if r_home == away_team:
                    a_shots.append(_f(r.get('home_shots') or r.get('home_shots_total')))
                    a_sot.append(_f(r.get('home_shots_on_goal') or r.get('home_shots_on_target')))
                    a_corners.append(_f(r.get('home_corners')))
                    a_poss.append(_f(r.get('home_possession'), 50))
                    a_goals_scored.append(gh)
                    a_goals_conceded.append(ga)
                    a_games += 1
                    if gh > ga: a_wins += 1
                elif r_away == away_team:
                    a_shots.append(_f(r.get('away_shots') or r.get('away_shots_total')))
                    a_sot.append(_f(r.get('away_shots_on_goal') or r.get('away_shots_on_target')))
                    a_corners.append(_f(r.get('away_corners')))
                    a_poss.append(_f(r.get('away_possession'), 50))
                    a_goals_scored.append(ga)
                    a_goals_conceded.append(gh)
                    a_games += 1
                    if ga > gh: a_wins += 1

                if (r_home == home_team and r_away == away_team) or (r_home == away_team and r_away == home_team):
                    h2h_total += 1
                    if (r_home == home_team and gh > ga) or (r_home == away_team and ga > gh):
                        h2h_h_wins += 1

                if len(h_shots) >= 5 and len(a_shots) >= 5 and h2h_total >= 3:
                    break

            if h_shots:
                recent_h = h_shots[-5:]
                _form_shots_diff = (sum(recent_h) / len(recent_h)) - (sum(a_shots[-5:]) / len(a_shots[-5:]) if a_shots else 0)
            if h_sot:
                _form_sot_diff = (sum(h_sot[-5:]) / len(h_sot[-5:])) - (sum(a_sot[-5:]) / len(a_sot[-5:]) if a_sot else 0)
            if h_corners:
                _form_corners_diff = (sum(h_corners[-5:]) / len(h_corners[-5:])) - (sum(a_corners[-5:]) / len(a_corners[-5:]) if a_corners else 0)
            if h_poss:
                _form_poss_h = sum(h_poss[-5:]) / len(h_poss[-5:])
            if a_poss:
                _form_poss_a = sum(a_poss[-5:]) / len(a_poss[-5:])
            if h_goals_scored:
                _home_avg_goals_scored = sum(h_goals_scored[-5:]) / len(h_goals_scored[-5:])
            if a_goals_conceded:
                _away_avg_goals_conceded = sum(a_goals_conceded[-5:]) / len(a_goals_conceded[-5:])

            _form_diff = (h_wins / max(h_games, 1)) - (a_wins / max(a_games, 1))
            _h2h_win_rate = h2h_h_wins / max(h2h_total, 1)
            _h2h_total = h2h_total

        date_str = str(row.get('date', '') or row.get('match_date', '') or row.get('startTimestamp', ''))
        if date_str and len(date_str) >= 7 and '-' in date_str:
            try:
                month = int(date_str[5:7])
                _month_sin = math.sin(2 * math.pi * month / 12)
                _month_cos = math.cos(2 * math.pi * month / 12)
            except:
                pass
    else:
        feats = row_or_feats
        # Base stats
        _pos_diff = _f(feats.get('pos_diff'), 0)
        _shots_diff = _f(feats.get('shots_diff'), 0)
        _sot_diff = _f(feats.get('sot_diff'), 0)
        _corners_diff = _f(feats.get('corner_diff'), 0)
        _fouls_diff = _f(feats.get('foul_diff'), 0)
        _yellow_diff = _f(feats.get('yellow_diff'), 0)
        _red_diff = _f(feats.get('red_diff'), 0)
        _inside_box_shots_diff = _f(feats.get('h_inner_shots'), 0) - _f(feats.get('a_inner_shots'), 0)
        h_xg = _f(feats.get('h_xg'), 0)
        a_xg = _f(feats.get('a_xg'), 0)
        _xg_diff = h_xg - a_xg
        _xg_per_shot_diff = _f(feats.get('xg_per_shot_diff'), 0)
        # Team ratings
        _home_attack_rating = _f(feats.get('h_att_imp', feats.get('ta_h_rating', 1.0)), 1.0)
        _home_defense_rating = _f(feats.get('h_def_imp', feats.get('ta_h_rating', 1.0)), 1.0)
        _away_defense_rating = _f(feats.get('a_def_imp', feats.get('ta_a_rating', 1.0)), 1.0)
        _attack_x_defense = _home_attack_rating / max(_away_defense_rating, 0.1)
        _odds_h = _f(feats.get('odds_h'), 2.0)
        _odds_a = _f(feats.get('odds_a'), 2.0)
        _odds_ratio = _odds_a / max(_odds_h, 0.01)
        # Efficiency
        _sot_ratio_h = _f(feats.get('sot_ratio_h', 0), 0)
        _sot_ratio_a = _f(feats.get('sot_ratio_a', 0), 0)
        _possession_efficiency_h = _f(feats.get('poss_eff_h', feats.get('possession_efficiency_h', 0)), 0)
        _possession_efficiency_a = _f(feats.get('poss_eff_a', feats.get('possession_efficiency_a', 0)), 0)
        # Form & H2H
        _form_diff = _f(feats.get('h_mom_gicko', feats.get('form_diff', 0)), 0)
        _h2h_win_rate = _f(feats.get('h2h_home_win_rate', feats.get('h2h_win_rate', 0)), 0)
        _h2h_total = int(_f(feats.get('h2h_total_matches', feats.get('h2h_total', 0)), 0))
        _form_shots_diff = _f(feats.get('form_shots_diff', 0), 0)
        _form_sot_diff = _f(feats.get('form_sot_diff', 0), 0)
        _form_corners_diff = _f(feats.get('form_corners_diff', 0), 0)
        _form_poss_h = _f(feats.get('form_poss_h', 50), 50)
        _form_poss_a = _f(feats.get('form_poss_a', 50), 50)
        _home_avg_goals_scored = _f(feats.get('home_avg_goals_scored', 0), 0)
        _away_avg_goals_conceded = _f(feats.get('away_avg_goals_conceded', 0), 0)
        # Temporal
        _month_sin = _f(feats.get('month_sin'), 0)
        _month_cos = _f(feats.get('month_cos'), 0)

    return [
        _pos_diff, _shots_diff, _sot_diff, _corners_diff,
        _fouls_diff, _yellow_diff, _red_diff, _inside_box_shots_diff,
        _xg_diff, _xg_per_shot_diff,
        _home_attack_rating, _home_defense_rating,
        _attack_x_defense, _odds_ratio,
        _form_diff, _h2h_win_rate, float(_h2h_total),
        _form_shots_diff, _form_sot_diff, _form_corners_diff,
        _form_poss_h, _form_poss_a,
        _sot_ratio_h, _sot_ratio_a,
        _possession_efficiency_h, _possession_efficiency_a,
        _month_sin, _month_cos,
        _home_avg_goals_scored, _away_avg_goals_conceded,
    ]


# V551 — Pruned V55: only features that proved valuable (xg_per_shot + market mispricing)
FEATURE_NAMES_V551 = FEATURE_NAMES_V54 + [
    'xg_per_shot_h', 'xg_per_shot_a',
    'odds_implied_minus_xg_prob_h', 'odds_implied_minus_xg_prob_a',
    'data_completeness_score'
]

# V552 — Same features as V551, trained with chronological split (2022-2026) + V54-like hyperparams
FEATURE_NAMES_V552 = FEATURE_NAMES_V551 + [
    'draw_deadlock', 'draw_defensive_eq'
]

# V553 — WC2026 Context Features: FIFA ranking, squad value, age, confederation
FEATURE_NAMES_V553 = FEATURE_NAMES_V552 + [
    'fifa_rank_h', 'fifa_rank_a',
    'fifa_pts_h', 'fifa_pts_a',
    'squad_value_h', 'squad_value_a',
    'squad_size_h', 'squad_size_a',
    'avg_age_h', 'avg_age_a',
    'fifa_rank_diff', 'squad_value_diff',
    'conf_uefa_h', 'conf_conmebol_h',
    'conf_uefa_a', 'conf_conmebol_a',
    # Tunisia crowd vote features (added from Titanium V3)
    'h_tn_vote_consent', 'a_tn_vote_consent', 'tn_vote_consent_diff',
    'h_tn_vote_sentiment', 'a_tn_vote_sentiment', 'tn_vote_sentiment_diff',
    'h_tn_vote_divergence', 'a_tn_vote_divergence', 'tn_vote_divergence_diff',
    'h_tn_vote_volatility', 'a_tn_vote_volatility', 'tn_vote_volatility_diff',
    'h_tn_jackpot_pressure', 'a_tn_jackpot_pressure', 'tn_jackpot_pressure_diff',
    'h_tn_crowd_conviction', 'a_tn_crowd_conviction', 'tn_crowd_conviction_diff',
    # Raw promosport vote percentages
    'vote_home_pct', 'vote_draw_pct', 'vote_away_pct',
    'vote_advantage_home', 'vote_home_norm',
]

# [TITANIUM V3] ELITE AI FEATURES - Full Environmental Intelligence (V54) + Tunisia Crowdsourcing
FEATURE_NAMES_TITANIUM = FEATURE_NAMES_V54 + [
    'h_pts', 'a_pts', 'pts_diff',
    'humidity',
    'ip_h', 'ip_d', 'ip_a',
    'is_extreme_weather',
    'news_is_missing_gk', 'news_is_missing_scorer', 'news_is_missing_captain', 'news_is_missing_star',
    'odds_velocity', 'is_derby',
    # Tunisia Crowdsourcing Features
    'h_tn_vote_consent', 'a_tn_vote_consent', 'tn_vote_consent_diff',
    'h_tn_vote_sentiment', 'a_tn_vote_sentiment', 'tn_vote_sentiment_diff',
    'h_tn_vote_divergence', 'a_tn_vote_divergence', 'tn_vote_divergence_diff',
    'h_tn_vote_volatility', 'a_tn_vote_volatility', 'tn_vote_volatility_diff',
    'h_tn_jackpot_pressure', 'a_tn_jackpot_pressure', 'tn_jackpot_pressure_diff',
    'h_tn_crowd_conviction', 'a_tn_crowd_conviction', 'tn_crowd_conviction_diff'
]



# V46/V47 Features - Used by the Surgical Intelligence Module (not for raw XGBoost)
SURGICAL_FEATURES = [
    'news_is_missing_gk', 'news_is_missing_scorer', 'news_is_missing_captain', 'news_is_missing_star',
    'h_mkt_val', 'a_mkt_val', 'ref_bias', 'is_pressure'
]

# V20 Volatility Tiers (Quantum)
# Tags features by their expected variance to inform Monte Carlo injection.
FEATURE_VOLATILITY = {
    # Low Volatility (Fixed/Slow-moving)
    "home_elo": 0.01, "away_elo": 0.01, "h_mkt_val": 0.02, "a_mkt_val": 0.02,
    "h2h_home_win_rate": 0.04, "h2h_away_win_rate": 0.04, "h2h_draw_rate": 0.04,
    "market_reliability": 0.01,
    
    # Medium Volatility (Statistical averages / Performance)
    "h_pos": 0.07, "a_pos": 0.07, "h_xg": 0.12, "a_xg": 0.12, 
    "h_sot": 0.15, "a_sot": 0.15, "h_bc": 0.18, "a_bc": 0.18,
    "h_pass_acc": 0.06, "a_pass_acc": 0.06,
    "h_int": 0.12, "h_tackles": 0.12, "h_clear": 0.15,
    "xg_elo_delta_h": 0.08, "xg_elo_delta_a": 0.08,
    
    # High Volatility (Psychological/News/Momentum/Disrupted)
    "home_motivation": 0.22, "away_motivation": 0.22, 
    "news_sent": 0.35, "v26_momentum_trend": 0.45,
    "is_pressure": 0.35, "home_injury_impact": 0.40, "away_injury_impact": 0.40,
    "h_odds_move_24h": 0.20, "a_odds_move_24h": 0.20,
    "h_def_err": 0.50, "a_def_err": 0.50,  # High volatility on mistakes
    
    # V53 Enhanced Features
    "h_xga": 0.12, "a_xga": 0.12, "xga_diff": 0.15,
    "h_xg_overperformance": 0.35, "a_xg_overperformance": 0.35,
    "h_xpts": 0.18, "a_xpts": 0.18,
    "h_conversion_rate": 0.25, "a_conversion_rate": 0.25,
    "h_sot_rate": 0.12, "a_sot_rate": 0.12,
    "h_shot_volume": 0.10, "a_shot_volume": 0.10,
    "h_clean_streak": 0.30, "a_clean_streak": 0.30,
    "h_scoring_streak": 0.25, "a_scoring_streak": 0.25,
    "h_win_streak": 0.30, "a_win_streak": 0.30,
    "h2h_avg_goals": 0.20, "h2h_over25_rate": 0.18, "h2h_avg_xg": 0.18, "h2h_archive_matches": 0.05,
    "h_shrink_factor": 0.02, "a_shrink_factor": 0.02,
    "day_of_week": 0.05, "kickoff_hour": 0.08,
    "match_importance": 0.25,
    "h_successful_dribbles": 0.18, "a_successful_dribbles": 0.18,
    "h_accurate_long_balls": 0.14, "a_accurate_long_balls": 0.14,
    "h_accurate_crosses": 0.16, "a_accurate_crosses": 0.16,
    "h_opp_half_passes": 0.10, "a_opp_half_passes": 0.10,
    "h_duels_won_pct": 0.08, "a_duels_won_pct": 0.08,
    "h_errors_leading_to_shot": 0.40, "a_errors_leading_to_shot": 0.40,

    # V54 Enhanced Passing Detail
    "h_accurate_opp_half_passes": 0.10, "a_accurate_opp_half_passes": 0.10,
    "h_opp_half_pass_pct": 0.06, "a_opp_half_pass_pct": 0.06,
    "h_acc_own_half_passes": 0.08, "a_acc_own_half_passes": 0.08,
    "h_long_ball_pct": 0.10, "a_long_ball_pct": 0.10,
    "h_cross_pct": 0.12, "a_cross_pct": 0.12,

    # V54 Ground & Aerial Duels
    "h_ground_duels_won": 0.14, "a_ground_duels_won": 0.14,
    "h_ground_duel_pct": 0.08, "a_ground_duel_pct": 0.08,
    "h_aerial_duel_pct": 0.10, "a_aerial_duel_pct": 0.10,
    "h_total_duels": 0.08, "a_total_duels": 0.08,

    # V54 Ball Recovery & Blocks
    "h_ball_recovery": 0.12, "a_ball_recovery": 0.12,
    "h_blocked_shots": 0.15, "a_blocked_shots": 0.15,
    "h_assists": 0.18, "a_assists": 0.18,

    # V54 Defensive (Against)
    "h_shots_faced": 0.12, "a_shots_faced": 0.12,
    "h_sot_faced": 0.12, "a_sot_faced": 0.12,
    "h_bc_conceded": 0.18, "a_bc_conceded": 0.18,
    "h_key_passes_allowed": 0.14, "a_key_passes_allowed": 0.14,
    "h_corners_conceded": 0.10, "a_corners_conceded": 0.10,
    "h_dribbles_allowed": 0.14, "a_dribbles_allowed": 0.14,

    # V54 Computed Proxies
    "h_ppda": 0.12, "a_ppda": 0.12,
    "h_prog_passes": 0.10, "a_prog_passes": 0.10,
    "h_sca": 0.16, "a_sca": 0.16,

    # Titanium-Specific Features
    "h_pts": 0.01, "a_pts": 0.01, "pts_diff": 0.02,
    "humidity": 0.05, "is_extreme_weather": 0.15,
    "ip_h": 0.02, "ip_d": 0.02, "ip_a": 0.02,
    "news_is_missing_gk": 0.25, "news_is_missing_scorer": 0.25,
    "news_is_missing_captain": 0.25, "news_is_missing_star": 0.30,
    "odds_velocity": 0.20, "is_derby": 0.08,

    # V55 Feature Crosses & Composites
    "xg_per_shot_h": 0.10, "xg_per_shot_a": 0.10,
    "sot_per_possession_h": 0.08, "sot_per_possession_a": 0.08,
    "goals_per_xg_h": 0.30, "goals_per_xg_a": 0.30,
    "sot_conceded_per_possession_h": 0.10, "sot_conceded_per_possession_a": 0.10,
    "shots_faced_per_xg_h": 0.12, "shots_faced_per_xg_a": 0.12,
    "form_x_momentum_h": 0.30, "form_x_momentum_a": 0.30,
    "elo_x_home_advantage": 0.02,
    "odds_implied_minus_xg_prob_h": 0.12, "odds_implied_minus_xg_prob_a": 0.12,
    "sharp_money_x_odds_move_h": 0.30, "sharp_money_x_odds_move_a": 0.30,
    "day_sin": 0.05, "day_cos": 0.05, "month_sin": 0.05, "month_cos": 0.05,
    "has_actual_xg": 0.01, "has_actual_odds": 0.01, "has_match_stats": 0.01,
    "is_modern_football_era": 0.01, "data_completeness_score": 0.02,

    # Legacy Derived Diffs (low volatility — noise cancels out)
    "elo_diff": 0.02, "tactical_synergy": 0.04,
    "pos_diff": 0.04, "pass_acc_diff": 0.04, "xg_diff": 0.04,
    "bc_diff": 0.04, "sot_diff": 0.04, "int_diff": 0.04,
    "tackles_diff": 0.04, "clear_diff": 0.04, "foul_diff": 0.04,
    "corner_diff": 0.04, "lost_diff": 0.04,
    "h2h_total_matches": 0.02,
    "h_style_enc": 0.03, "a_style_enc": 0.03,
    "d_odds_move_24h": 0.20,
    "liquidity_index": 0.02, "data_completeness": 0.02,
    "motivation_context": 0.22,

    # Legacy Per-Match Stats (medium volatility)
    "h_shots_off": 0.15, "a_shots_off": 0.15,
    "h_inner_shots": 0.14, "a_inner_shots": 0.14,
    "a_int": 0.12, "a_tackles": 0.12, "a_clear": 0.15,
    "h_saves": 0.18, "a_saves": 0.18,
    "h_ground_won": 0.10, "a_ground_won": 0.10,
    "h_aerial_won": 0.12, "a_aerial_won": 0.12,
    "h_poss_lost": 0.10, "a_poss_lost": 0.10,
    "h_corners": 0.08, "a_corners": 0.08,
    "h_fouls": 0.10, "a_fouls": 0.10,
    "h_cards": 0.12, "a_cards": 0.12,
    "h_mom_gicko": 0.15, "a_mom_gicko": 0.15,
    "h_att_imp": 0.06, "a_att_imp": 0.06,

    # Market & Environmental
    "odds_h": 0.08, "odds_a": 0.08,
    "temp": 0.05, "rest_h": 0.08, "rest_a": 0.08,
    "travel_f": 0.10, "is_cup": 0.15,
    "ref_yellow_avg": 0.06, "ref_red_avg": 0.06, "ref_pen_avg": 0.06,
    "weather_impact": 0.10,
    "v26_momentum_h": 0.30, "v26_momentum_a": 0.30,
    "v26_lineups_confirmed": 0.20,

    # Top Analyst Market Intelligence
    "ta_true_prob_h": 0.08, "ta_true_prob_d": 0.08, "ta_true_prob_a": 0.08,
    "ta_odds_change_speed_h": 0.25, "ta_odds_change_speed_a": 0.25,
    "ta_sharp_money_h": 0.20, "ta_sharp_money_a": 0.20, "ta_sharp_money_d": 0.20,
    "ta_sharp_money_indicator": 0.15,
    "ta_xg_h": 0.12, "ta_xg_a": 0.12,
    "ta_sot_h": 0.15, "ta_sot_a": 0.15,
    "ta_news_impact": 0.30, "ta_news_sentiment": 0.35,
    "ta_over_25_prob": 0.10, "ta_under_25_prob": 0.10,
    "ta_expected_total_goals": 0.10,
    "ta_value_bet_flag": 0.20, "ta_highest_value_index": 0.15,
    "ta_market_confidence_indicator": 0.08,
    "ta_team_strength_indicator": 0.06, "ta_momentum_indicator": 0.20,
    "ta_goal_expectation_indicator": 0.10,
    "ta_h_rating": 0.06, "ta_a_rating": 0.06, "ta_rating_diff": 0.08,

    # Tunisia Crowdsourcing Features (TITANIUM V3)
    # High volatility: crowd sentiment changes rapidly, influenced by news
    "h_tn_vote_consent": 0.25, "a_tn_vote_consent": 0.25, "tn_vote_consent_diff": 0.30,
    "h_tn_vote_sentiment": 0.30, "a_tn_vote_sentiment": 0.30, "tn_vote_sentiment_diff": 0.35,
    "h_tn_vote_divergence": 0.20, "a_tn_vote_divergence": 0.20, "tn_vote_divergence_diff": 0.25,
    "h_tn_vote_volatility": 0.35, "a_tn_vote_volatility": 0.35, "tn_vote_volatility_diff": 0.40,
    "h_tn_jackpot_pressure": 0.15, "a_tn_jackpot_pressure": 0.15, "tn_jackpot_pressure_diff": 0.20,
    "h_tn_crowd_conviction": 0.28, "a_tn_crowd_conviction": 0.28, "tn_crowd_conviction_diff": 0.32,

    # Raw Promosport vote percentages
    "vote_home_pct": 0.20, "vote_draw_pct": 0.20, "vote_away_pct": 0.20,
    "vote_advantage_home": 0.25, "vote_home_norm": 0.20,
}


def calculate_travel_fatigue(home_team, away_team):
    """
    Ultra Factor V19: Estimates fatigue based on Haversine distance.
    Uses a lookup table for major football cities.
    """
    if not home_team or not away_team: return 0.0
    
    COORDS = {
        # Europe
        "London": (51.5074, -0.1278), "Manchester": (53.4808, -2.2426), "Liverpool": (53.4084, -2.9916),
        "Madrid": (40.4168, -3.7038), "Barcelona": (41.3851, 2.1734), "Munich": (48.1351, 11.5820),
        "Dortmund": (51.5136, 7.4653), "Paris": (48.8566, 2.3522), "Marseille": (43.2965, 5.3698),
        "Milan": (45.4642, 9.1900), "Turin": (45.0703, 7.6869), "Rome": (41.9028, 12.4964),
        "Amsterdam": (52.3676, 4.9041), "Lisbon": (38.7223, -9.1393), "Porto": (41.1579, -8.6291),
        "Istanbul": (41.0082, 28.9784), "Athens": (37.9838, 23.7275), "Brussels": (50.8503, 4.3517),
        "Vienna": (48.2082, 16.3738), "Warsaw": (52.2297, 21.0122), "Prague": (50.0755, 14.4378),
        "Budapest": (47.4979, 19.0402), "Naples": (40.8518, 14.2681), "Frankfurt": (50.1109, 8.6821),
        "Leipzig": (51.3397, 12.3731), "Leicester": (52.6369, -1.1398), "Glasgow": (55.8642, -4.2518),
        "Aberdeen": (57.1497, -2.0943), "Belfast": (54.5973, -5.9301), "Seville": (37.3891, -5.9845),
        "Valencia": (39.4699, -0.3763), "Lille": (50.6292, 3.0573), "Lyon": (45.7640, 4.8357),
        # England expansion (League One/National League cities)
        "Birmingham": (52.4862, -1.8904), "Bristol": (51.4545, -2.5879),
        "Blackpool": (53.8175, -3.0357), "Reading": (51.4543, -0.9781),
        "Huddersfield": (53.6458, -1.7850), "Bolton": (53.5815, -2.4282),
        "York": (53.9591, -1.0815), "Rochdale": (53.6150, -2.1550), 
        "Carlisle": (54.8925, -2.9329), "Barnet": (51.6444, -0.1997),
        "Eastleigh": (50.9667, -1.3500), "Woking": (51.3162, -0.5593),
        # Middle East & Africa (Expanding for USER)
        "Riyadh": (24.7136, 46.6753), "Jeddah": (21.5433, 39.1728), "Dubai": (25.2048, 55.2708),
        "Doha": (25.2854, 51.5310), "Abu Dhabi": (24.4539, 54.3773), "Cairo": (30.0444, 31.2357),
        "Casablanca": (33.5731, -7.5898), "Tunis": (36.8065, 10.1815), "Algiers": (36.7538, 3.0588),
        "Pretoria": (-25.7479, 28.2293), "Johannesburg": (-26.2041, 28.0473), "Cape Town": (-33.9249, 18.4241),
        "Dammam": (26.4207, 50.0888), "Medina": (24.5247, 39.5692), "Mecca": (21.3891, 39.8579),
        "Kuwait City": (29.3759, 47.9774), "Manama": (26.2285, 50.5860), "Muscat": (23.5859, 58.4059),
        "Amman": (31.9454, 35.9284), "Beirut": (33.8938, 35.5018), "Baghdad": (33.3152, 44.3661)
    }
    
    # Try to find city in team name
    h_coord, a_coord = None, None
    for city, coord in COORDS.items():
        if city.lower() in home_team.lower(): h_coord = coord
        if city.lower() in away_team.lower(): a_coord = coord
    
    if not h_coord or not a_coord: return 0.0
    
    # Haversine distance (approximate)
    lat1, lon1 = h_coord
    lat2, lon2 = a_coord
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2)**2
    dist = 2 * 6371 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    
    # Fatigue scale: 0 to 5.0 (5.0 = 5000km+ travel)
    return min(5.0, dist / 1000.0)
