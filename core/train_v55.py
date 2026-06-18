import os
import json
import math
import sqlite3
import numpy as np
import pandas as pd
import xgboost as xgb
from datetime import datetime, timezone
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, log_loss
from sklearn.utils.class_weight import compute_sample_weight
import optuna

import sys
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from ml_features import extract_ml_features, FEATURE_NAMES_V55, FEATURE_NAMES_V551, FEATURE_NAMES_V552, FEATURE_NAMES_V553, FEATURE_VOLATILITY, get_wc2026_team_data
from top_analyst_engine import process_match_for_top_analyst

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
DB_PATH = os.path.join(BASE_DIR, 'data', 'historical_archive.sqlite')
MODEL_PATH = os.path.join(BASE_DIR, 'models', 'stitch_v55_optimized.json')
MODEL_PATH_V551 = os.path.join(BASE_DIR, 'models', 'stitch_v551_optimized.json')
MODEL_PATH_V552 = os.path.join(BASE_DIR, 'models', 'stitch_v552_optimized.json')
MODEL_PATH_V553 = os.path.join(BASE_DIR, 'models', 'stitch_v553_optimized.json')
MODEL_PATH_V553_PREMIUM = os.path.join(BASE_DIR, 'models', 'stitch_v553_premium.json')
PREMIUM_CSV_PATH = os.path.join(BASE_DIR, 'data', 'v553_wc2026_premium.csv')

LEAGUE_CODE_MAP = {
    'E0': 'English Premier League', 'E1': 'English Championship',
    'E2': 'English League One', 'E3': 'English League Two',
    'SP1': 'Spanish La Liga', 'SP2': 'Spanish Segunda',
    'D1': 'German Bundesliga', 'D2': 'German 2. Bundesliga',
    'I1': 'Italian Serie A', 'I2': 'Italian Serie B',
    'F1': 'French Ligue 1', 'F2': 'French Ligue 2',
}

def _parse_date_to_ts(date_str):
    if not date_str:
        return 0
    try:
        dt = datetime.strptime(str(date_str)[:10], '%Y-%m-%d')
        return int(dt.replace(tzinfo=timezone.utc).timestamp())
    except:
        return 0

def _build_stats_dict(row):
    stats = {}
    mapping = {
        'shots_home': 'Total shots_home', 'shots_away': 'Total shots_away',
        'sot_home': 'Shots on target_home', 'sot_away': 'Shots on target_away',
        'fouls_home': 'Fouls_home', 'fouls_away': 'Fouls_away',
        'corners_home': 'Corner kicks_home', 'corners_away': 'Corner kicks_away',
        'yellow_home': 'Yellow cards_home', 'yellow_away': 'Yellow cards_away',
        'red_home': 'Red cards_home', 'red_away': 'Red cards_away',
    }
    for col, key in mapping.items():
        val = row.get(col) if isinstance(row, dict) else row[col]
        if val is not None:
            stats[key] = float(val)
    return stats

def _map_wc2026_row(row):
    row_dict = dict(row)
    match_date = row_dict.get('match_date', '')
    ts = _parse_date_to_ts(match_date)
    mapped = {
        'homeTeam': row_dict['team1'],
        'awayTeam': row_dict['team2'],
        'scoreHome': row_dict.get('score_ft_home'),
        'scoreAway': row_dict.get('score_ft_away'),
        'startTimestamp': ts,
        'match_date': match_date,
        'league': 'World Cup 2026',
        'tournament_name': 'World Cup 2026',
        'odds_home': row_dict.get('odds_home') or 2.5,
        'odds_draw': row_dict.get('odds_draw') or 3.2,
        'odds_away': row_dict.get('odds_away') or 2.8,
        'form_context': '{}',
        'h2h_data': '{}',
        'player_ratings_home': '[]',
        'player_ratings_away': '[]',
        'home_att': 1.0, 'away_att': 1.0,
        'news_sentiment': 0, 'weather_temp': 20.0,
        'days_since_last_match_home': 4,
        'days_since_last_match_away': 4,
        'stats_blob': '[]',
        'teamStats': '{}',
        'odds_movement_24h': '{}',
        'odds_home_open': 2.5,
    }
    return mapped

def _map_international_row(row):
    row_dict = dict(row)
    match_date = row_dict.get('date', '')
    ts = _parse_date_to_ts(match_date)
    neutral = str(row_dict.get('neutral', '0')).upper() == 'TRUE' or str(row_dict.get('neutral', '0')) == '1'
    mapped = {
        'homeTeam': row_dict['home_team'],
        'awayTeam': row_dict['away_team'],
        'scoreHome': int(row_dict['home_score']) if row_dict.get('home_score') and str(row_dict['home_score']).strip().isdigit() else None,
        'scoreAway': int(row_dict['away_score']) if row_dict.get('away_score') and str(row_dict['away_score']).strip().isdigit() else None,
        'startTimestamp': ts,
        'match_date': match_date,
        'league': row_dict.get('tournament', 'International'),
        'tournament_name': row_dict.get('tournament', 'International'),
        'odds_home': 2.5, 'odds_draw': 3.2, 'odds_away': 2.8,
        'form_context': '{}', 'h2h_data': '{}',
        'player_ratings_home': '[]', 'player_ratings_away': '[]',
        'home_att': 1.0, 'away_att': 1.0,
        'news_sentiment': 0, 'weather_temp': 20.0,
        'days_since_last_match_home': 90,
        'days_since_last_match_away': 90,
        'stats_blob': '[]', 'teamStats': '{}',
        'odds_movement_24h': '{}', 'odds_home_open': 2.5,
    }
    # Neutral matches: swap neutral venue flag
    if neutral:
        mapped['is_neutral'] = 1.0
    return mapped

def _map_soccer_row(row):
    row_dict = dict(row)
    match_date = row_dict.get('date', '')
    ts = _parse_date_to_ts(match_date)

    mapped = {
        'homeTeam': row_dict['home_team'],
        'awayTeam': row_dict['away_team'],
        'league': row_dict.get('league_name', ''),
        'scoreHome': row_dict.get('goals_home'),
        'scoreAway': row_dict.get('goals_away'),
        'odds_home': row_dict.get('odds_home') or row_dict.get('odds_home_alt'),
        'odds_draw': row_dict.get('odds_draw') or row_dict.get('odds_draw_alt'),
        'odds_away': row_dict.get('odds_away') or row_dict.get('odds_away_alt'),
        'startTimestamp': ts,
        'match_date': match_date,
    }

    stats = {}
    stat_map_cols = {
        'home_shots_total': 'Total shots_home', 'away_shots_total': 'Total shots_away',
        'home_shots_on_goal': 'Shots on target_home', 'away_shots_on_goal': 'Shots on target_away',
        'home_fouls': 'Fouls_home', 'away_fouls': 'Fouls_away',
        'home_corners': 'Corner kicks_home', 'away_corners': 'Corner kicks_away',
        'home_yellow_cards': 'Yellow cards_home', 'away_yellow_cards': 'Yellow cards_away',
        'home_red_cards': 'Red cards_home', 'away_red_cards': 'Red cards_away',
    }
    for col, key in stat_map_cols.items():
        val = row_dict.get(col)
        if val is not None:
            stats[key] = float(val)
    mapped['stats_blob'] = json.dumps(stats) if stats else '[]'

    ts_h, ts_a = {}, {}
    stat_map = {
        'avgShots': ('home_shots_total', 'away_shots_total'),
        'avgShotsOnTarget': ('home_shots_on_goal', 'away_shots_on_goal'),
        'avgFouls': ('home_fouls', 'away_fouls'),
        'avgCorners': ('home_corners', 'away_corners'),
        'avgYellowCards': ('home_yellow_cards', 'away_yellow_cards'),
        'avgRedCards': ('home_red_cards', 'away_red_cards'),
    }
    for ts_key, (h_col, a_col) in stat_map.items():
        h_val = row_dict.get(h_col)
        a_val = row_dict.get(a_col)
        if h_val is not None: ts_h[ts_key] = float(h_val)
        if a_val is not None: ts_a[ts_key] = float(a_val)
    mapped['teamStats'] = json.dumps({'home': ts_h, 'away': ts_a}) if (ts_h or ts_a) else '{}'

    mapped['home_xg'] = row_dict.get('home_xg', 0) or 0
    mapped['away_xg'] = row_dict.get('away_xg', 0) or 0
    mapped['form_context'] = '{}'
    mapped['h2h_data'] = '{}'
    mapped['player_ratings_home'] = '[]'
    mapped['player_ratings_away'] = '[]'
    mapped['tournament_name'] = mapped.get('league', '')
    mapped['home_att'] = 1.0
    mapped['away_att'] = 1.0
    mapped['news_sentiment'] = 0
    mapped['weather_temp'] = 20.0
    mapped['days_since_last_match_home'] = 7
    mapped['days_since_last_match_away'] = 7
    mapped['odds_movement_24h'] = '{}'
    mapped['odds_home_open'] = mapped.get('odds_home')

    mapped['home_possession'] = row_dict.get('home_possession', 50.0)
    mapped['away_possession'] = row_dict.get('away_possession', 50.0)
    mapped['home_shots'] = row_dict.get('home_shots_total')
    mapped['away_shots'] = row_dict.get('away_shots_total')
    mapped['home_shots_on_target'] = row_dict.get('home_shots_on_goal')
    mapped['away_shots_on_target'] = row_dict.get('away_shots_on_goal')

    return mapped

def _map_international_premium_row(row):
    row_dict = dict(row) if not isinstance(row, dict) else row
    match_date = str(row_dict.get('date', ''))[:10]
    ts = _parse_date_to_ts(match_date)
    neutral = int(row_dict.get('neutral', 0))

    mapped = {
        'homeTeam': str(row_dict.get('home_team', 'Unknown')).strip(),
        'awayTeam': str(row_dict.get('away_team', 'Unknown')).strip(),
        'scoreHome': row_dict.get('home_score'),
        'scoreAway': row_dict.get('away_score'),
        'startTimestamp': ts,
        'match_date': match_date,
        'league': str(row_dict.get('tournament', 'International')),
        'tournament_name': str(row_dict.get('tournament', 'International')),
        'form_context': '{}', 'h2h_data': '{}',
        'player_ratings_home': '[]', 'player_ratings_away': '[]',
        'home_att': 1.0, 'away_att': 1.0,
        'news_sentiment': 0, 'weather_temp': 20.0,
        'days_since_last_match_home': 90,
        'days_since_last_match_away': 90,
        'odds_movement_24h': '{}',
    }

    if neutral:
        mapped['is_neutral'] = 1.0

    od_h = row_dict.get('odds_home')
    od_d = row_dict.get('odds_draw')
    od_a = row_dict.get('odds_away')
    if od_h and str(od_h).strip() and float(od_h) > 1.0:
        mapped['odds_home'] = float(od_h)
        mapped['odds_draw'] = float(od_d) if od_d and str(od_d).strip() else 3.2
        mapped['odds_away'] = float(od_a) if od_a and str(od_a).strip() else 2.8
        mapped['odds_home_open'] = float(od_h)
    else:
        mapped['odds_home'] = 2.5
        mapped['odds_draw'] = 3.2
        mapped['odds_away'] = 2.8
        mapped['odds_home_open'] = 2.5

    stats = {}
    stat_map = {
        'home_shots_total': 'Total shots_home',
        'away_shots_total': 'Total shots_away',
        'home_shots_on_goal': 'Shots on target_home',
        'away_shots_on_goal': 'Shots on target_away',
        'home_corners': 'Corner kicks_home',
        'away_corners': 'Corner kicks_away',
        'home_fouls': 'Fouls_home',
        'away_fouls': 'Fouls_away',
        'home_yellow_cards': 'Yellow cards_home',
        'away_yellow_cards': 'Yellow cards_away',
        'home_red_cards': 'Red cards_home',
        'away_red_cards': 'Red cards_away',
    }
    for col, key in stat_map.items():
        val = row_dict.get(col)
        if val is not None and str(val).strip():
            try:
                stats[key] = float(val)
            except ValueError:
                pass

    xg_h = row_dict.get('home_xg')
    xg_a = row_dict.get('away_xg')
    if xg_h is not None and str(xg_h).strip():
        try:
            mapped['home_xg'] = float(xg_h)
        except ValueError:
            pass
    if xg_a is not None and str(xg_a).strip():
        try:
            mapped['away_xg'] = float(xg_a)
        except ValueError:
            pass

    mapped['stats_blob'] = json.dumps(stats) if stats else '[]'

    ts_h, ts_a = {}, {}
    ts_fields = {
        'avgShots': ('home_shots_total', 'away_shots_total'),
        'avgShotsOnTarget': ('home_shots_on_goal', 'away_shots_on_goal'),
        'avgFouls': ('home_fouls', 'away_fouls'),
        'avgCorners': ('home_corners', 'away_corners'),
        'avgYellowCards': ('home_yellow_cards', 'away_yellow_cards'),
        'avgRedCards': ('home_red_cards', 'away_red_cards'),
    }
    for ts_key, (h_col, a_col) in ts_fields.items():
        h_val = row_dict.get(h_col)
        a_val = row_dict.get(a_col)
        if h_val is not None and str(h_val).strip():
            try: ts_h[ts_key] = float(h_val)
            except ValueError: pass
        if a_val is not None and str(a_val).strip():
            try: ts_a[ts_key] = float(a_val)
            except ValueError: pass

    poss_h = row_dict.get('home_possession')
    poss_a = row_dict.get('away_possession')
    if poss_h is not None and str(poss_h).strip():
        try: mapped['home_possession'] = float(poss_h)
        except ValueError: pass
    if poss_a is not None and str(poss_a).strip():
        try: mapped['away_possession'] = float(poss_a)
        except ValueError: pass

    mapped['teamStats'] = json.dumps({'home': ts_h, 'away': ts_a}) if (ts_h or ts_a) else '{}'

    return mapped


def _map_archive_football_row(row):
    row_dict = dict(row)
    match_date = row_dict.get('match_date')
    ts = _parse_date_to_ts(match_date)

    mapped = {
        'homeTeam': row_dict['home_team'],
        'awayTeam': row_dict['away_team'],
        'league': LEAGUE_CODE_MAP.get(row_dict.get('league_code', ''), row_dict.get('league_code', '')),
        'scoreHome': row_dict.get('score_home'),
        'scoreAway': row_dict.get('score_away'),
        'odds_home': row_dict.get('odds_home'),
        'odds_draw': row_dict.get('odds_draw'),
        'odds_away': row_dict.get('odds_away'),
        'startTimestamp': ts,
        'match_date': match_date,
    }

    stats = _build_stats_dict(row_dict)
    mapped['stats_blob'] = json.dumps(stats) if stats else '[]'

    ts_h, ts_a = {}, {}
    stat_map = {
        'avgShots': ('shots_home', 'shots_away'),
        'avgShotsOnTarget': ('sot_home', 'sot_away'),
        'avgFouls': ('fouls_home', 'fouls_away'),
        'avgCorners': ('corners_home', 'corners_away'),
        'avgYellowCards': ('yellow_home', 'yellow_away'),
        'avgRedCards': ('red_home', 'red_away'),
    }
    for ts_key, (h_col, a_col) in stat_map.items():
        h_val = row_dict.get(h_col)
        a_val = row_dict.get(a_col)
        if h_val is not None: ts_h[ts_key] = float(h_val)
        if a_val is not None: ts_a[ts_key] = float(a_val)
    mapped['teamStats'] = json.dumps({'home': ts_h, 'away': ts_a}) if (ts_h or ts_a) else '{}'

    row_fallbacks = {
        'home_possession': 50.0, 'away_possession': 50.0,
        'home_shots': row_dict.get('shots_home'), 'away_shots': row_dict.get('shots_away'),
        'home_shots_on_target': row_dict.get('sot_home'), 'away_shots_on_target': row_dict.get('sot_away'),
        'home_fouls': row_dict.get('fouls_home'), 'away_fouls': row_dict.get('fouls_away'),
        'home_corners': row_dict.get('corners_home'), 'away_corners': row_dict.get('corners_away'),
    }
    mapped.update({k: v for k, v in row_fallbacks.items() if v is not None})

    mapped['home_xg'] = row_dict.get('xg_home') or row_dict.get('home_xg', 0)
    mapped['away_xg'] = row_dict.get('xg_away') or row_dict.get('away_xg', 0)
    mapped['form_context'] = '{}'
    mapped['h2h_data'] = '{}'
    mapped['player_ratings_home'] = '[]'
    mapped['player_ratings_away'] = '[]'
    mapped['tournament_name'] = mapped.get('league', '')
    mapped['home_att'] = 1.0
    mapped['away_att'] = 1.0
    mapped['news_sentiment'] = 0
    mapped['weather_temp'] = 20.0
    mapped['days_since_last_match_home'] = 7
    mapped['days_since_last_match_away'] = 7

    odds_h = row_dict.get('odds_home')
    odds_d = row_dict.get('odds_draw')
    odds_a = row_dict.get('odds_away')
    clos_h = row_dict.get('closing_odds_home')
    clos_d = row_dict.get('closing_odds_draw')
    clos_a = row_dict.get('closing_odds_away')
    if clos_h and odds_h:
        odds_move = {
            'h_pct': round((clos_h / odds_h - 1) * 100, 2),
            'a_pct': round((clos_a / odds_a - 1) * 100, 2) if clos_a and odds_a else 0,
            'd_pct': round((clos_d / odds_d - 1) * 100, 2) if clos_d and odds_d else 0,
            'is_reliable': 1,
        }
        mapped['odds_movement_24h'] = json.dumps(odds_move)
        mapped['odds_home_open'] = odds_h
    else:
        mapped['odds_movement_24h'] = '{}'
        mapped['odds_home_open'] = odds_h

    return mapped

def compute_time_weight(match_date_str, lambda_decay=0.0015):
    if not match_date_str:
        return 0.5
    try:
        dt = datetime.strptime(str(match_date_str)[:10], '%Y-%m-%d')
        days_ago = (datetime.now() - dt).days
        if days_ago < 0:
            days_ago = 0
        return math.exp(-lambda_decay * days_ago)
    except:
        return 0.5

def mixup_augmentation(X, y, alpha=0.3, p=0.3):
    n = len(X)
    mask = np.random.random(n) < p
    if not mask.any():
        return X, y
    indices = np.random.permutation(n)
    lam = np.random.beta(alpha, alpha, n)
    X_mix = X.copy()
    y_mix = y.copy()
    for i in np.where(mask)[0]:
        j = indices[i]
        l = lam[i]
        X_mix[i] = X[i] * (1 - l) + X[j] * l
        y_mix[i] = y[i]
    return X_mix, y_mix

def noise_augment_v2(X, y, noise_levels, rng=None):
    if rng is None:
        rng = np.random.default_rng(42)
    X_aug = X.copy()
    n, m = X_aug.shape
    for i in range(min(m, len(noise_levels))):
        vol = noise_levels[i]
        if vol > 0:
            noise = rng.normal(0, vol * 1.5, n)
            mask = (X[:, i] != 0) & (X[:, i] != 1)
            X_aug[mask, i] *= (1.0 + noise[mask])
    return np.vstack([X, X_aug]), np.concatenate([y, y])

def process_row(row_dict, feature_names):
    try:
        ts = row_dict.get('startTimestamp', 0)
        if ts: ts = ts if ts > 1e11 else ts * 1000
        base_feats = extract_ml_features(row_dict, fetch_history=True, current_match_ts=ts)
        match_payload = {
            'homeTeam': row_dict.get('homeTeam', 'Unknown'),
            'awayTeam': row_dict.get('awayTeam', 'Unknown'),
            'league': row_dict.get('league', 'Unknown'),
            'odds_home': row_dict.get('odds_home') or base_feats.get('odds_h', 2.0),
            'odds_draw': row_dict.get('odds_draw') or 3.0,
            'odds_away': row_dict.get('odds_away') or base_feats.get('odds_a', 3.0),
            'home_xg': base_feats.get('h_xg', 0),
            'away_xg': base_feats.get('a_xg', 0),
            'player_ratings_home': row_dict.get('player_ratings_home', '[]'),
            'player_ratings_away': row_dict.get('player_ratings_away', '[]'),
            'stats': json.loads(row_dict.get('stats_blob', '[]')),
        }
        match_payload['odds_home_open'] = row_dict.get('odds_home_open') or match_payload['odds_home']
        ta_result = process_match_for_top_analyst(match_payload)
        ta_feats = ta_result.get('ml_features', {})
        full_feats = {**base_feats, **ta_feats}
        row_vector = [full_feats.get(f, 0.0) for f in feature_names]
        hg = row_dict.get('scoreHome')
        ag = row_dict.get('scoreAway')
        if hg is not None and ag is not None:
            label = 0 if hg > ag else (1 if hg == ag else 2)
        else:
            return None, None
        return row_vector, label
    except Exception:
        return None, None

def load_data(limit=60000, min_year=None, feature_names=None, wc2026=False, premium=False):
    if feature_names is None:
        feature_names = FEATURE_NAMES_V55
    tag = "V553" if wc2026 else ("V551" if feature_names is FEATURE_NAMES_V551 else "V55")
    print("[%s] Loading data with time weights and quality gates..." % tag)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Pre-load WC2026 team cache so extract_ml_features can find them
    if wc2026:
        get_wc2026_team_data()

    if min_year:
        df_fb = pd.read_sql(
            "SELECT * FROM archive_football_data WHERE match_date >= ? ORDER BY match_date DESC LIMIT ?",
            conn, params=('%d-01-01' % min_year, limit)
        )
    else:
        df_fb = pd.read_sql(
            "SELECT * FROM archive_football_data ORDER BY match_date DESC LIMIT ?",
            conn, params=(limit,)
        )
    print(f"   Loaded {len(df_fb)} rows from archive_football_data%s" % (" (post-"+str(min_year)+")" if min_year else ""))
    if not wc2026:
        df_am = pd.read_sql(
            "SELECT * FROM archive_matches WHERE stats_blob IS NOT NULL LIMIT ?",
            conn, params=(limit,)
        )
        print(f"   Loaded {len(df_am)} rows from archive_matches")
    else:
        df_wc = pd.read_sql(
            "SELECT * FROM wc2026_matches ORDER BY match_date DESC",
            conn
        )
        print(f"   Loaded {len(df_wc)} rows from wc2026_matches")

        if premium and os.path.exists(PREMIUM_CSV_PATH):
            df_premium = pd.read_csv(PREMIUM_CSV_PATH)
            df_premium = df_premium[df_premium['home_score'].notna()]
            if min_year:
                df_premium = df_premium[df_premium['date'] >= f'{min_year}-01-01']
            print(f"   Loaded {len(df_premium)} rows from premium CSV (enriched international)")
            df_intl = df_premium
            intl_mapper = 'premium'
        else:
            # Load international_results with scores (post-2020 for modern data)
            df_intl = pd.read_sql(
                "SELECT * FROM international_results WHERE date >= '2020-01-01' AND home_score IS NOT NULL ORDER BY date DESC",
                conn
            )
            print(f"   Loaded {len(df_intl)} rows from international_results")
            intl_mapper = 'standard'

        df_am = pd.DataFrame()  # skip archive_matches in WC mode
    conn.close()

    data, labels, sample_weights = [], [], []
    match_dates = []
    valid = 0

    for _, row in df_fb.iterrows():
        mapped = _map_archive_football_row(row)
        vec, lab = process_row(mapped, feature_names)
        if vec is None:
            continue
        data.append(vec)
        labels.append(lab)
        match_dates.append(mapped.get('match_date', ''))
        valid += 1
        if valid % 5000 == 0:
            print(f"   ... Processed {valid} records.")

    if wc2026:
        for _, row in df_intl.iterrows():
            if intl_mapper == 'premium':
                mapped = _map_international_premium_row(row)
            else:
                mapped = _map_international_row(row)
            vec, lab = process_row(mapped, feature_names)
            if vec is None:
                continue
            data.append(vec)
            labels.append(lab)
            match_dates.append(mapped.get('match_date', ''))
            valid += 1
            if valid % 2000 == 0:
                print(f"   ... Processed {valid} records.")
        for _, row in df_wc.iterrows():
            mapped = _map_wc2026_row(row)
            vec, lab = process_row(mapped, feature_names)
            if vec is None:
                continue
            data.append(vec)
            labels.append(lab)
            match_dates.append(mapped.get('match_date', ''))
            valid += 1
    else:
        for _, row in df_am.iterrows():
            vec, lab = process_row(dict(row), feature_names)
            if vec is None:
                continue
            data.append(vec)
            labels.append(lab)
            match_dates.append(row.get('match_date', ''))
            valid += 1

    sample_weights = np.array([compute_time_weight(d) for d in match_dates])
    print("[%s] Extracted %d rows with %d features." % (tag, valid, len(feature_names)))
    print("[%s] Time weight range: %.4f – %.4f" % (tag, sample_weights.min(), sample_weights.max()))
    print("[%s] Class distribution: Home=%d Draw=%d Away=%d" % (tag, labels.count(0), labels.count(1), labels.count(2)))
    return pd.DataFrame(data, columns=feature_names), np.array(labels), sample_weights, match_dates

BEST_PARAMS_PATH = os.path.join(BASE_DIR, 'models', 'v55_best_params.json')
BEST_PARAMS_PATH_CV = os.path.join(BASE_DIR, 'models', 'v55_cv_best_params.json')

class OptunaPruningCallback(xgb.callback.TrainingCallback):
    def __init__(self, trial):
        self.trial = trial

    def after_iteration(self, model, epoch, evals_log):
        if evals_log and 'validation_0' in evals_log:
            metric = evals_log['validation_0'].get('mlogloss')
            if metric and len(metric) > 0 and epoch % 3 == 0:
                val_loss = metric[-1]
                self.trial.report(val_loss, epoch)
                if self.trial.should_prune():
                    raise optuna.TrialPruned()
        return False


def objective(trial, X_train_small, y_train_small, sw_train_small, X_val, y_val):
    """Standard Optuna objective with fixed validation set (faster, may overfit)."""
    param = {
        'objective': 'multi:softprob',
        'num_class': 3,
        'eval_metric': 'mlogloss',
        'verbosity': 0,
        'random_state': 42,
        'tree_method': 'hist',
        'nthread': -1,
        'learning_rate': trial.suggest_float('learning_rate', 0.01, 0.1, log=True),
        'max_depth': trial.suggest_int('max_depth', 3, 6),
        'subsample': trial.suggest_float('subsample', 0.7, 1.0),
        'colsample_bytree': trial.suggest_float('colsample_bytree', 0.7, 1.0),
        'min_child_weight': trial.suggest_int('min_child_weight', 1, 5),
        'gamma': trial.suggest_float('gamma', 0, 2.0),
        'reg_alpha': trial.suggest_float('reg_alpha', 0, 1.0),
        'reg_lambda': trial.suggest_float('reg_lambda', 0, 2.0),
    }

    cw = compute_sample_weight(class_weight='balanced', y=y_train_small)
    cw = cw / cw.mean()

    dtrain = xgb.DMatrix(
        X_train_small.values if hasattr(X_train_small, 'values') else X_train_small,
        label=y_train_small,
        weight=cw
    )
    dval = xgb.DMatrix(
        X_val.values if hasattr(X_val, 'values') else X_val,
        label=y_val
    )

    pruning_cb = OptunaPruningCallback(trial)
    es_cb = xgb.callback.EarlyStopping(
        rounds=15,
        metric_name='mlogloss',
        data_name='validation_0',
        maximize=False,
        save_best=True
    )

    model = xgb.train(
        param, dtrain, num_boost_round=800,
        evals=[(dval, 'validation_0')],
        callbacks=[pruning_cb, es_cb],
        verbose_eval=False
    )

    y_pred = model.predict(dval)
    y_pred_labels = np.argmax(y_pred, axis=1)
    acc = accuracy_score(y_val, y_pred_labels)
    return acc


def objective_cv(trial, X, y, sw, match_dates, n_folds=3):
    """CV Optuna using TimeSeriesSplit to avoid overfitting small val sets."""
    from sklearn.model_selection import TimeSeriesSplit

    param = {
        'objective': 'multi:softprob',
        'num_class': 3,
        'eval_metric': 'mlogloss',
        'verbosity': 0,
        'random_state': 42,
        'tree_method': 'hist',
        'nthread': -1,
        'learning_rate': trial.suggest_float('learning_rate', 0.01, 0.1, log=True),
        'max_depth': trial.suggest_int('max_depth', 3, 6),
        'subsample': trial.suggest_float('subsample', 0.7, 1.0),
        'colsample_bytree': trial.suggest_float('colsample_bytree', 0.7, 1.0),
        'min_child_weight': trial.suggest_int('min_child_weight', 1, 5),
        'gamma': trial.suggest_float('gamma', 0, 2.0),
        'reg_alpha': trial.suggest_float('reg_alpha', 0, 1.0),
        'reg_lambda': trial.suggest_float('reg_lambda', 0, 2.0),
    }

    X_arr = X.values if hasattr(X, 'values') else np.array(X)
    y_arr = np.array(y)
    sw_arr = np.array(sw)

    # Reverse to ascending chronological order (load_data returns DESC)
    X_arr = X_arr[::-1]
    y_arr = y_arr[::-1]

    scores = []
    tscv = TimeSeriesSplit(n_splits=n_folds)

    for fold, (train_idx, val_idx) in enumerate(tscv.split(X_arr)):
        X_fold = X_arr[train_idx]
        y_fold = y_arr[train_idx]
        X_val_fold = X_arr[val_idx]
        y_val_fold = y_arr[val_idx]

        cw = compute_sample_weight(class_weight='balanced', y=y_fold)
        cw = cw / cw.mean()

        dtrain = xgb.DMatrix(X_fold, label=y_fold, weight=cw)
        dval = xgb.DMatrix(X_val_fold, label=y_val_fold)

        es_cb = xgb.callback.EarlyStopping(
            rounds=15, metric_name='mlogloss',
            data_name='validation_0', maximize=False, save_best=True
        )

        model = xgb.train(
            param, dtrain, num_boost_round=400,
            evals=[(dval, 'validation_0')],
            callbacks=[es_cb],
            verbose_eval=False
        )

        y_pred = model.predict(dval)
        y_pred_labels = np.argmax(y_pred, axis=1)
        acc = accuracy_score(y_val_fold, y_pred_labels)
        scores.append(acc)

    return np.mean(scores)

def _chronological_split(X, y, sw, split_dates):
    """
    Chronological split: train on all data before val_start,
    validate between val_start and test_start, test after test_start.
    split_dates = (val_start, test_start) as string dates 'YYYY-MM-DD'.
    Assumes DataFrame has a 'match_date' column or the indices align with load_data output.
    Since load_data returns DataFrame without dates, we pass match_dates separately.
    """
    val_start, test_start = split_dates
    train_idx = [i for i, d in enumerate(sw) if d < 0]  # dummy, overridden below
    return train_test_split(X, y, sw, test_size=0.3, random_state=42, stratify=y)

def train_v55(use_optuna=False, use_optuna_cv=False, use_v551=False, post2010=False, modern=False, wc2026=False, premium=False):
    if premium:
        tag = "V553_PREMIUM"
    elif wc2026:
        tag = "V553"
    elif modern:
        tag = "V552"
    else:
        tag = "V551" if use_v551 else "V55"

    if premium:
        # V553_PREMIUM: premium enriched data + W2026 features
        model_path = MODEL_PATH_V553_PREMIUM
        feat_names = FEATURE_NAMES_V553
        min_year = 2022
        val_cut = '2026-04-01'
        test_cut = '2026-05-01'
        v552_params = {
            'learning_rate': 0.03,
            'max_depth': 6,
            'subsample': 0.85,
            'colsample_bytree': 0.85,
            'min_child_weight': 1,
            'gamma': 0.5,
            'reg_alpha': 0.1,
            'reg_lambda': 1.0,
        }
        limit = 30000
    elif wc2026:
        # V553: WC2026-context features + 2022-2026 data + WC2026 matches
        model_path = MODEL_PATH_V553
        feat_names = FEATURE_NAMES_V553
        min_year = 2022
        val_cut = '2026-04-01'
        test_cut = '2026-05-01'
        v552_params = {
            'learning_rate': 0.03,
            'max_depth': 6,
            'subsample': 0.85,
            'colsample_bytree': 0.85,
            'min_child_weight': 1,
            'gamma': 0.5,
            'reg_alpha': 0.1,
            'reg_lambda': 1.0,
        }
        limit = 30000
    elif modern:
        # V552: top features + 2022-2026 clean data + chronological split
        model_path = MODEL_PATH_V552
        feat_names = FEATURE_NAMES_V551
        min_year = 2022
        val_cut = '2026-04-01'
        test_cut = '2026-05-01'
        v552_params = {
            'learning_rate': 0.03,
            'max_depth': 6,
            'subsample': 0.85,
            'colsample_bytree': 0.85,
            'min_child_weight': 1,
            'gamma': 0.5,
            'reg_alpha': 0.1,
            'reg_lambda': 1.0,
        }
    else:
        model_path = MODEL_PATH_V551 if use_v551 else MODEL_PATH
        feat_names = FEATURE_NAMES_V551 if use_v551 else FEATURE_NAMES_V55
        min_year = 2010 if post2010 else None
        val_cut = test_cut = None
        v552_params = None

    print("=" * 60)
    if premium:
        mode_desc = "Premium enriched + WC2026+2022-2026"
    elif wc2026:
        mode_desc = "WC2026+2022-2026"
    elif modern:
        mode_desc = "2022-2026 chronological"
    else:
        mode_desc = "Post-2010" if post2010 else "Full data"
    print("%s TRAINING — %s" % (tag, mode_desc))
    print("=" * 60)

    limit = 30000 if (post2010 or modern or wc2026 or premium) else 60000
    X, y, sw, match_dates = load_data(limit=limit, min_year=min_year, feature_names=feat_names, wc2026=(wc2026 or premium), premium=premium)
    if len(X) < 100:
        print("[FAIL] Not enough data.")
        return

    # Chronological split for modern / wc2026 mode
    if modern or wc2026 or premium:
        print("[%s] Chronological split: Train < 2026-04, Val = 2026-04, Test >= 2026-05" % tag)
        train_i, val_i, test_i = [], [], []
        for i, md in enumerate(match_dates):
            md_str = str(md) if md else ''
            if md_str < val_cut:
                train_i.append(i)
            elif md_str < test_cut:
                val_i.append(i)
            else:
                test_i.append(i)

        if not val_i or not test_i:
            print("[WARN] No val/test matches after val_cut — using random temporal split instead")
            n = len(X)
            train_i = list(range(int(n * 0.7)))
            val_i = list(range(int(n * 0.7), int(n * 0.85)))
            test_i = list(range(int(n * 0.85), n))

        X_train, y_train, sw_train = X.iloc[train_i], y[train_i], sw[train_i]
        X_val, y_val, sw_val = X.iloc[val_i], y[val_i], sw[val_i]
        X_test, y_test, sw_test = X.iloc[test_i], y[test_i], sw[test_i]
    else:
        X_train, X_temp, y_train, y_temp, sw_train, sw_temp = train_test_split(
            X, y, sw, test_size=0.3, random_state=42, stratify=y
        )
        X_val, X_test, y_val, y_test, sw_val, sw_test = train_test_split(
            X_temp, y_temp, sw_temp, test_size=0.5, random_state=42, stratify=y_temp
        )

    print("[%s] Train: %d Val: %d Test: %d" % (tag, len(X_train), len(X_val), len(X_test)))

    X_val_np = X_val.values if hasattr(X_val, 'values') else X_val
    y_val_np = y_val.values if hasattr(y_val, 'values') else y_val

    best_params = None
    if use_optuna or use_optuna_cv or not os.path.exists(BEST_PARAMS_PATH):
        if not (use_optuna or use_optuna_cv) and os.path.exists(BEST_PARAMS_PATH):
            print("[%s] Optuna not requested, using saved best params." % tag)
        elif use_optuna_cv:
            print("[%s] Running Optuna CV hyperparameter search (15 trials, 3-fold TimeSeriesSplit) ..." % tag)
            study = optuna.create_study(direction='maximize', sampler=optuna.samplers.TPESampler(seed=42))
            study.optimize(
                lambda t: objective_cv(t, X_train, y_train, sw_train, match_dates),
                n_trials=15
            )
            best_params = study.best_params
            best_acc = study.best_value
            print("[%s-Optuna-CV] Best CV accuracy: %.2f%%" % (tag, best_acc*100))
            print("[%s-Optuna-CV] Best params: %s" % (tag, best_params))
            with open(BEST_PARAMS_PATH_CV, 'w') as f:
                json.dump(best_params, f, indent=2)
            print("[%s-Optuna-CV] Params saved to %s" % (tag, BEST_PARAMS_PATH_CV))
        elif use_optuna:
            print("[%s] Running Optuna hyperparameter search (30 trials) ..." % tag)
            X_sub = X_train.iloc[:15000] if len(X_train) > 15000 else X_train
            y_sub = y_train[:15000] if len(y_train) > 15000 else y_train
            sw_sub = sw_train[:15000] if len(sw_train) > 15000 else sw_train
            study = optuna.create_study(direction='maximize', sampler=optuna.samplers.TPESampler(seed=42))
            study.optimize(
                lambda t: objective(t, X_sub, y_sub, sw_sub, X_val_np, y_val_np),
                n_trials=30
            )
            best_params = study.best_params
            best_acc = study.best_value
            print("[%s-Optuna] Best val acc: %.2f%%" % (tag, best_acc*100))
            print("[%s-Optuna] Best params: %s" % (tag, best_params))
            with open(BEST_PARAMS_PATH, 'w') as f:
                json.dump(best_params, f, indent=2)
            print("[%s-Optuna] Params saved to %s" % (tag, BEST_PARAMS_PATH))
    else:
        with open(BEST_PARAMS_PATH, 'r') as f:
            best_params = json.load(f)
        print("[%s] Loaded saved params: %s" % (tag, best_params))

    if best_params is None:
        best_params = v552_params if (modern or wc2026 or premium) else {
            'learning_rate': 0.05, 'max_depth': 6, 'subsample': 0.8,
            'colsample_bytree': 0.8, 'min_child_weight': 1,
            'gamma': 0, 'reg_alpha': 0, 'reg_lambda': 1,
        }
        print("[%s] Using %s params: %s" % (tag, ("V552/V553" if (modern or wc2026 or premium) else "fallback"), best_params))

    class_weights = compute_sample_weight(class_weight='balanced', y=y_train)
    class_weights = class_weights / class_weights.mean()

    n_est = 800 if (modern or wc2026 or premium) else 500
    final_params = dict(best_params)
    final_params.update({
        'tree_method': 'hist',
        'nthread': -1,
    })
    model = xgb.XGBClassifier(
        objective='multi:softprob',
        num_class=3,
        eval_metric='mlogloss',
        verbosity=0,
        random_state=42,
        n_estimators=n_est,
        early_stopping_rounds=30,
        **final_params
    )

    model.fit(
        X_train.values, y_train,
        sample_weight=class_weights,
        eval_set=[(X_val_np, y_val_np)],
        verbose=True
    )

    # --- Evaluation ---
    X_test_np = X_test.values if hasattr(X_test, 'values') else X_test
    y_test_np = y_test.values if hasattr(y_test, 'values') else y_test

    y_pred = np.argmax(model.predict_proba(X_test_np), axis=1)
    acc = accuracy_score(y_test_np, y_pred)
    ll = log_loss(y_test_np, model.predict_proba(X_test_np))

    print("\n%s" % ('='*50))
    print("[%s] Test Accuracy: %.2f%%" % (tag, acc*100))
    print("[%s] Log Loss:      %.4f" % (tag, ll))
    print("%s" % ('='*50))

    # --- Per-class breakdown ---
    for cls, name in [(0, 'Home'), (1, 'Draw'), (2, 'Away')]:
        mask = y_test_np == cls
        if mask.sum() > 0:
            cls_acc = (y_pred[mask] == cls).mean()
            print("  %5s: %.1f%% (N=%d)" % (name, cls_acc*100, mask.sum()))

    # --- Save model ---
    model.get_booster().save_model(model_path)
    print("[%s] Model saved to %s" % (tag, model_path))

    # --- Feature importance ---
    imp = model.get_booster().get_score(importance_type='weight')
    sorted_imp = sorted(imp.items(), key=lambda x: -x[1])[:20]
    print("\n[%s-TOP20] Feature Importance:" % tag)
    for fname, s in sorted_imp:
        print("   %s: %s" % (fname, s))

    return model, acc, ll

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--optuna', action='store_true', help='Run Optuna HP search (fixed val set)')
    parser.add_argument('--optuna-cv', action='store_true', help='Run Optuna CV HP search (3-fold TimeSeriesSplit, 15 trials)')
    parser.add_argument('--v551', action='store_true', help='Train V551 (pruned features)')
    parser.add_argument('--post2010', action='store_true', help='Only post-2010 data')
    parser.add_argument('--modern', action='store_true', help='V552: 2022-2026 + chronological split')
    parser.add_argument('--wc2026', action='store_true', help='V553: WC2026 features + WC2026 match data')
    parser.add_argument('--premium', action='store_true', help='V553_PREMIUM: use enriched international data (odds, xG, squad features)')
    args = parser.parse_args()

    use_op = args.optuna or args.optuna_cv
    use_op_cv = args.optuna_cv

    if args.premium:
        train_v55(premium=True, use_optuna=use_op, use_optuna_cv=use_op_cv)
    elif args.wc2026:
        train_v55(modern=True, use_v551=False, post2010=False, use_optuna=use_op, use_optuna_cv=use_op_cv)
    elif args.v551:
        train_v55(use_v551=True, post2010=args.post2010, use_optuna=use_op, use_optuna_cv=use_op_cv)
    else:
        train_v55(post2010=args.post2010, use_optuna=use_op, use_optuna_cv=use_op_cv)

    # After any training, if v55_best_params.json exists and contains Optuna results,
    # we may need to delete it to avoid reusing overfitted params on next run
