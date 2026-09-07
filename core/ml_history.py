# -*- coding: utf-8 -*-
"""Acces donnees & helpers analytiques (extrait de ml_features.py, split 2026-09-07).
Fondation partagee : connexions DB, historique equipes, styles, ELO, blessures,
h2h, fatigue, motivation. Ne PAS importer ml_extract ici (sens unique)."""
import json
import sqlite3
import os
import math
import functools

DB_ARCHIVE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'historical_archive.sqlite')
DB_TACTICAL_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'tactical.db')
ELO_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'elo_ratings.json')
STYLES_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'team_styles.json')

try:
    from pg_connector import using_postgres, get_pg_connection, query as pg_query, get_league_params
except Exception:
    # Dev local sans pg_connector : on simule le mode SQLite (using_postgres() -> False).
    # En prod (pg_connector present) ce bloc n'est pas utilise.
    def using_postgres():
        return False
    def get_pg_connection(*a, **k):
        raise RuntimeError("pg_connector indisponible en dev local")
    def pg_query(*a, **k):
        raise RuntimeError("pg_connector indisponible en dev local")
    def get_league_params(*a, **k):
        return {}

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


def _get_team_history_master(team_name, limit=10, current_match_ts=None):
    """Team history from data_pipeline master.db (pre-computed rolling features).
    Falls back to None if master.db is unavailable (caller continues to archive)."""
    try:
        from data_loader import get_master_connection
        conn = get_master_connection()
        if conn is None:
            return None

        clean_name = team_name.strip()

        import time
        from datetime import datetime
        cutoff_ts = int(current_match_ts) if current_match_ts else int(time.time())
        cutoff_date = datetime.fromtimestamp(cutoff_ts).strftime('%Y-%m-%d')

        rows = conn.execute("""
            SELECT date, home_team, away_team, fthg, ftag, ftr,
                   elo_home, elo_away, home_xg, away_xg,
                   H_xg_L5, H_xga_L5, A_xg_L5, A_xga_L5,
                   H_gf_L5, H_ga_L5, A_gf_L5, A_ga_L5,
                   H_pts_L5, A_pts_L5,
                   H_xg_L10, H_xga_L10, A_xg_L10, A_xga_L10,
                   H_gf_L10, H_ga_L10, A_gf_L10, A_ga_L10,
                   H_pts_L10, A_pts_L10
            FROM master_matches
            WHERE (home_team = ? OR away_team = ?)
              AND fthg IS NOT NULL AND ftag IS NOT NULL
              AND date < ?
            ORDER BY date DESC LIMIT ?
        """, (clean_name, clean_name, cutoff_date, limit)).fetchall()
        if not rows:
            return None

        history = []
        for r in rows:
            h_team = r['home_team'] or ''
            a_team = r['away_team'] or ''
            is_home = (h_team.strip().lower() == clean_name.lower())

            s_for = _f(r['fthg'], 0)
            s_ag = _f(r['ftag'], 0)
            if not is_home:
                s_for, s_ag = s_ag, s_for

            points = 3.0 if s_for > s_ag else (1.0 if s_for == s_ag else 0.0)

            norm = {
                'score_for': s_for,
                'score_against': s_ag,
                'points': points,
                'opponent_name': a_team if is_home else h_team,
                'match_date': r['date'] or '',
            }
            # Carry pre-computed rolling features normalized to THIS team's perspective
            _FEAT_SIDE = {
                'pts_L5': ('H_pts_L5', 'A_pts_L5'),
                'xg_L5': ('H_xg_L5', 'A_xg_L5'),
                'xga_L5': ('H_xga_L5', 'A_xga_L5'),
                'gf_L5': ('H_gf_L5', 'A_gf_L5'),
                'ga_L5': ('H_ga_L5', 'A_ga_L5'),
                'pts_L10': ('H_pts_L10', 'A_pts_L10'),
                'xg_L10': ('H_xg_L10', 'A_xg_L10'),
                'xga_L10': ('H_xga_L10', 'A_xga_L10'),
                'gf_L10': ('H_gf_L10', 'A_gf_L10'),
                'ga_L10': ('H_ga_L10', 'A_ga_L10'),
            }
            for out_key, (h_key, a_key) in _FEAT_SIDE.items():
                val = r[h_key] if is_home else r[a_key]
                if val is not None:
                    norm[out_key] = _f(val, 0)
            if r['elo_home'] is not None:
                norm['elo'] = _f(r['elo_home'], 1500) if is_home else _f(r['elo_away'], 1500)
            if r['home_xg'] is not None and r['away_xg'] is not None:
                norm['xg_for'] = _f(r['home_xg'], 0) if is_home else _f(r['away_xg'], 0)
                norm['xg_against'] = _f(r['away_xg'], 0) if is_home else _f(r['home_xg'], 0)

            history.append(norm)

        return history[:limit]
    except Exception:
        import sys
        sys.stderr.write("[PG] master history error\n")
        return None


@functools.lru_cache(maxsize=256)
def get_team_history(team_name, limit=10, current_match_ts=None):
    # Use Neon PostgreSQL first if available
    if using_postgres():
        pg_hist = _get_team_history_pg(team_name, limit, current_match_ts)
        if pg_hist:
            return pg_hist

    # Use master.db (data_pipeline pre-computed features) next — richest local source
    master_hist = _get_team_history_master(team_name, limit, current_match_ts)
    if master_hist:
        return master_hist

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
        try:
            rows_intl = conn.execute(query_intl, (clean_name, cutoff_date, clean_name, cutoff_date, limit)).fetchall()
        except Exception:
            rows_intl = []

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
    If history entries carry pre-computed rolling features (master.db), those
    take precedence over recomputing from raw score/points.
    """
    LEAGUE_AVG_GOALS = 1.2
    LEAGUE_AVG_PTS = 1.0

    if not history_list:
        return LEAGUE_AVG_GOALS, LEAGUE_AVG_PTS

    # Pre-computed rolling features (master.db) — most recent match carries L5/L10
    if history_list:
        first = history_list[0]
        if 'pts_L5' in first and 'xg_L5' in first:
            return _f(first['xg_L5'], LEAGUE_AVG_GOALS), _f(first['pts_L5'], LEAGUE_AVG_PTS)
        if 'pts_L5' in first and 'gf_L5' in first:
            return _f(first['gf_L5'], LEAGUE_AVG_GOALS), _f(first['pts_L5'], LEAGUE_AVG_PTS)

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

    weighted_goals = 0.0
    weighted_points = 0.0
    total_weight = 0.0

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
