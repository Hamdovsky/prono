import os
import json
import sqlite3
import numpy as np
import pandas as pd
import xgboost as xgb
import optuna
try:
    import shap
except Exception:
    shap = None
import joblib
from datetime import datetime, timezone
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, log_loss
from sklearn.utils.class_weight import compute_sample_weight

# Ensure paths correctly resolve to the core functionality
import sys
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from ml_features import extract_ml_features, FEATURE_NAMES_V54, FEATURE_VOLATILITY
from top_analyst_engine import process_match_for_top_analyst

# Paths
BASE_DIR = os.path.dirname(os.path.dirname(__file__))
DB_PATH = os.path.join(BASE_DIR, 'data', 'historical_archive.sqlite')
MODEL_XGB_PATH = os.path.join(BASE_DIR, 'models', 'stitch_v24_hybrid.json')
SHAP_EXPLAINER_PATH = os.path.join(BASE_DIR, 'models', 'shap_explainer_v24.pkl')

LEAGUE_CODE_MAP = {
    'E0': 'English Premier League', 'E1': 'English Championship',
    'E2': 'English League One', 'E3': 'English League Two',
    'SP1': 'Spanish La Liga', 'SP2': 'Spanish Segunda',
    'D1': 'German Bundesliga', 'D2': 'German 2. Bundesliga',
    'I1': 'Italian Serie A', 'I2': 'Italian Serie B',
    'F1': 'French Ligue 1', 'F2': 'French Ligue 2',
    'N1': 'Dutch Eredivisie', 'B1': 'Belgian Pro League',
    'P1': 'Portuguese Primeira Liga', 'T1': 'Turkish Super Lig',
    'SC0': 'Scottish Premiership', 'SC1': 'Scottish Championship',
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

def _map_archive_football_row(row):
    row_dict = dict(row)
    mapped = {
        'homeTeam': row_dict['home_team'],
        'awayTeam': row_dict['away_team'],
        'league': LEAGUE_CODE_MAP.get(row_dict.get('league_code', ''), row_dict.get('league_code', '')),
        'scoreHome': row_dict.get('score_home'),
        'scoreAway': row_dict.get('score_away'),
        'odds_home': row_dict.get('odds_home'),
        'odds_draw': row_dict.get('odds_draw'),
        'odds_away': row_dict.get('odds_away'),
        'startTimestamp': _parse_date_to_ts(row_dict.get('match_date')),
        'match_date': row_dict.get('match_date'),
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

    # Sharp money signal from closing odds
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

def build_match_payload_from_row(row, base_feats):
    """
    Transforms a historical DB row and its base features into the standard match 
    dictionary required by the Top Analyst Engine.
    """
    row_dict = dict(row)
    match = {
        'homeTeam': row_dict.get('homeTeam', 'Unknown'),
        'awayTeam': row_dict.get('awayTeam', 'Unknown'),
        'league': row_dict.get('league', 'Unknown'),
        'odds_home': row_dict.get('odds_home') or base_feats.get('odds_h', 2.0),
        'odds_draw': row_dict.get('odds_draw') or 3.0,
        'odds_away': row_dict.get('odds_away') or base_feats.get('odds_a', 3.0),
        'home_xg': base_feats.get('h_xg', 0),
        'away_xg': base_feats.get('a_xg', 0),
        # Assuming the stats_blob holds player ratings arrays implicitly or we pass empty arrays if missing to avoid crashes
        'player_ratings_home': row_dict.get('player_ratings_home', '[]'),
        'player_ratings_away': row_dict.get('player_ratings_away', '[]'),
        'stats': json.loads(row_dict.get('stats_blob', '[]'))
    }
    
    # Try to extract open probabilities/odds if available from row for sharp money analysis
    match['odds_home_open'] = row_dict.get('odds_home_open') or match['odds_home']
    return match

def _process_row(row_dict):
    try:
        ts = row_dict.get('startTimestamp', 0)
        if ts: ts = ts if ts > 1e11 else ts * 1000

        base_feats = extract_ml_features(row_dict, fetch_history=True, current_match_ts=ts)

        match_payload = build_match_payload_from_row(row_dict, base_feats)

        ta_result = process_match_for_top_analyst(match_payload)
        ta_feats = ta_result.get('ml_features', {})

        full_feats = {**base_feats, **ta_feats}

        row_vector = [full_feats.get(f, 0.0) for f in FEATURE_NAMES_V54]
        hg = row_dict.get('scoreHome')
        ag = row_dict.get('scoreAway')
        if hg is not None and ag is not None:
            if hg > ag:
                label = 0
            elif hg == ag:
                label = 1
            else:
                label = 2
        else:
            return None
        return row_vector, label
    except Exception:
        return None

def load_data(limit=50000):
    print("[DB] Loading historical data for V53 training...")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # 1. Load from archive_football_data (all matches, with or without odds)
    df_fb = pd.read_sql(
        "SELECT * FROM archive_football_data ORDER BY match_date DESC LIMIT ?",
        conn, params=(limit,)
    )
    print(f"   Loaded {len(df_fb)} rows from archive_football_data")

    # 2. Also load from archive_matches (existing: 1k matches)
    df_am = pd.read_sql(
        "SELECT * FROM archive_matches WHERE stats_blob IS NOT NULL LIMIT ?",
        conn, params=(limit,)
    )
    print(f"   Loaded {len(df_am)} rows from archive_matches")
    conn.close()

    data, labels = [], []
    valid_matches = 0

    # Process archive_football_data rows
    for _, row in df_fb.iterrows():
        mapped = _map_archive_football_row(row)
        result = _process_row(mapped)
        if result is not None:
            data.append(result[0])
            labels.append(result[1])
            valid_matches += 1
            if valid_matches % 5000 == 0:
                print(f"   ... Processed {valid_matches} records.")

    # Process archive_matches rows (original logic)
    for _, row in df_am.iterrows():
        result = _process_row(dict(row))
        if result is not None:
            data.append(result[0])
            labels.append(result[1])
            valid_matches += 1

    print(f"[STATS] Extracted {valid_matches} rows with {len(FEATURE_NAMES_V54)} features successfully.")
    return pd.DataFrame(data, columns=FEATURE_NAMES_V54), np.array(labels)

def objective_xgb(trial, X_train, y_train, X_val, y_val):
    params = {
        'objective': 'multi:softprob',
        'eval_metric': 'mlogloss',
        'num_class': 3,
        'learning_rate': trial.suggest_float('learning_rate', 0.005, 0.3),
        'max_depth': trial.suggest_int('max_depth', 3, 12),
        'subsample': trial.suggest_float('subsample', 0.5, 1.0),
        'colsample_bytree': trial.suggest_float('colsample_bytree', 0.4, 1.0),
        'colsample_bylevel': trial.suggest_float('colsample_bylevel', 0.4, 1.0),
        'n_estimators': trial.suggest_int('n_estimators', 200, 1000),
        'min_child_weight': trial.suggest_int('min_child_weight', 1, 10),
        'gamma': trial.suggest_float('gamma', 0, 5),
        'reg_alpha': trial.suggest_float('reg_alpha', 0, 5),
        'reg_lambda': trial.suggest_float('reg_lambda', 0, 5),
        'early_stopping_rounds': 20
    }
    model = xgb.XGBClassifier(**params)
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
    preds = model.predict_proba(X_val)
    return log_loss(y_val, preds)

def run_v24_upgrade():
    os.makedirs(os.path.join(BASE_DIR, 'models'), exist_ok=True)
    print("[V53] Starting Automated Top Analyst Market Intelligence Model Training...")
    
    X, y = load_data()
    if len(X) < 100:
        print("[FAIL] Not enough data to train V24. Extracted: ", len(X))
        return
        
    X_train, X_temp, y_train, y_temp = train_test_split(X, y, test_size=0.3, random_state=42)
    X_val, X_test, y_val, y_test = train_test_split(X_temp, y_temp, test_size=0.5, random_state=42)
    
    print("[TRAIN] Training XGBoost with default params (fast mode, no Optuna)...")
    best_params = {
        'learning_rate': 0.05, 'max_depth': 6, 'subsample': 0.8,
        'colsample_bytree': 0.8, 'n_estimators': 300,
        'objective': 'multi:softprob', 'num_class': 3,
        'early_stopping_rounds': 20, 'verbosity': 1, 'random_state': 42
    }
    best_xgb = xgb.XGBClassifier(**best_params)
    
    # [CLASS IMBALANCE FIX] Compute weights so Away Wins and Draws teach the model equally
    weights = compute_sample_weight(class_weight='balanced', y=y_train)
    
    # We also use a validation set for early stopping during the final fit
    best_xgb.fit(
        X_train, y_train, 
        sample_weight=weights, 
        eval_set=[(X_val, y_val)], 
        verbose=False
    )
    
    # 4. Accuracy Assessment
    y_pred = np.argmax(best_xgb.predict_proba(X_test), axis=1)
    acc = accuracy_score(y_test, y_pred)
    print(f"[MODEL] V24 Top Analyst XGBoost Accuracy: {acc*100:.2f}%")
    
    # 5. Save Model (use booster to avoid sklearn wrapper bug)
    best_xgb.get_booster().save_model(MODEL_XGB_PATH)
    print(f"[DISK] V53 Model saved successfully at {os.path.basename(MODEL_XGB_PATH)}")
    
    # 6. SHAP Explanability Update for V24 Dashboard
    if shap is not None:
        try:
            print("[SHAP] Generating SHAP Explainer for V24 variables...")
            explainer = shap.Explainer(best_xgb)
            joblib.dump(explainer, SHAP_EXPLAINER_PATH)
            print("[SHAP] Explainer dumped successfully.")
            
            # Display Top 10 features natively
            shap_values = explainer(X_train.head(500))
            mean_abs_shap = np.abs(shap_values.values).mean(axis=(0, 2))
            top_indices = np.argsort(mean_abs_shap)[::-1][:10]
            print("\n[TOP10] TOP 10 INFLUENCERS IN V53 MODEL")
            for idx in top_indices:
                print(f"   -> {FEATURE_NAMES_V54[idx]} (Importance: {mean_abs_shap[idx]:.4f})")
        except Exception as e:
            print("[WARN] SHAP evaluation skipped or failed: ", e)
    else:
        print("[WARN] SHAP not available, skipping explainer generation.")

if __name__ == "__main__":
    run_v24_upgrade()
