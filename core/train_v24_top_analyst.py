import os
import json
import sqlite3
import numpy as np
import pandas as pd
import xgboost as xgb
import optuna
import shap
import joblib
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, log_loss
from sklearn.utils.class_weight import compute_sample_weight

# Ensure paths correctly resolve to the core functionality
import sys
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from ml_features import extract_ml_features, FEATURE_NAMES_V24
from top_analyst_engine import process_match_for_top_analyst

# Paths
BASE_DIR = os.path.dirname(os.path.dirname(__file__))
DB_PATH = os.path.join(BASE_DIR, 'data', 'historical_archive.sqlite')
MODEL_XGB_PATH = os.path.join(BASE_DIR, 'models', 'stitch_v24_hybrid.json')
SHAP_EXPLAINER_PATH = os.path.join(BASE_DIR, 'models', 'shap_explainer_v24.pkl')

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

def load_data(limit=30000):
    print("[DB] Loading historical data for V24 Top Analyst Retrospective Analysis...")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    df = pd.read_sql(f"SELECT * FROM archive_matches WHERE stats_blob IS NOT NULL LIMIT {limit}", conn)
    conn.close()
    
    data, labels = [], []
    valid_matches = 0
    
    for i, row in df.iterrows():
        try:
            # [SKEW FIX] Extract timestamp to avoid data leakage during training
            ts = row['startTimestamp']
            if ts: ts = ts if ts > 1e11 else ts * 1000
            
            # 1. Extract base 66 features with history fetching enabled but strictly capped at match time!
            base_feats = extract_ml_features(dict(row), fetch_history=True, current_match_ts=ts)
            
            # 2. Build pseudo-live match payload for Top Analyst
            match_payload = build_match_payload_from_row(row, base_feats)
            
            # 3. Process through Top Analyst to get the 24-27 new features
            ta_result = process_match_for_top_analyst(match_payload)
            ta_feats = ta_result.get('ml_features', {})
            
            # 4. Merge dictionaries
            full_feats = {**base_feats, **ta_feats}
            
            # 5. Extract strictly by FEATURE_NAMES_V24 ordering
            row_vector = [full_feats.get(f, 0.0) for f in FEATURE_NAMES_V24]
            data.append(row_vector)
            
            # 6. Generate labels (0: Home, 1: Draw, 2: Away)
            hg, ag = row['scoreHome'], row['scoreAway']
            if hg > ag: labels.append(0)
            elif hg == ag: labels.append(1)
            else: labels.append(2)
            
            valid_matches += 1
            if valid_matches % 1000 == 0:
                print(f"   ... Processed {valid_matches} records safely.")
                
        except Exception as e:
            continue
            
    print(f"[STATS] Extracted {valid_matches} rows with {len(FEATURE_NAMES_V24)} features successfully.")
    return pd.DataFrame(data, columns=FEATURE_NAMES_V24), np.array(labels)

def objective_xgb(trial, X_train, y_train, X_val, y_val):
    params = {
        'objective': 'multi:softprob',
        'eval_metric': 'mlogloss',
        'num_class': 3,
        'learning_rate': trial.suggest_float('learning_rate', 0.01, 0.2),
        'max_depth': trial.suggest_int('max_depth', 3, 9),
        'subsample': trial.suggest_float('subsample', 0.6, 1.0),
        'colsample_bytree': trial.suggest_float('colsample_bytree', 0.6, 1.0),
        'n_estimators': trial.suggest_int('n_estimators', 100, 600)
    }
    model = xgb.XGBClassifier(**params)
    # [EARLY STOPPING FIX] Prevent overfitting on the training set
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False, early_stopping_rounds=15)
    preds = model.predict_proba(X_val)
    return log_loss(y_val, preds)

def run_v24_upgrade():
    os.makedirs(os.path.join(BASE_DIR, 'models'), exist_ok=True)
    print("[V24] Starting Automated Top Analyst Market Intelligence Model Training...")
    
    X, y = load_data()
    if len(X) < 100:
        print("[FAIL] Not enough data to train V24. Extracted: ", len(X))
        return
        
    X_train, X_temp, y_train, y_temp = train_test_split(X, y, test_size=0.3, random_state=42)
    X_val, X_test, y_val, y_test = train_test_split(X_temp, y_temp, test_size=0.5, random_state=42)
    
    print("[OPTI] Optimizing XGBoost V24 with Optuna for max Sharp Money detection accuracy...")
    try:
        optuna.logging.set_verbosity(optuna.logging.WARNING)
        study_xgb = optuna.create_study(direction='minimize')
        study_xgb.optimize(lambda t: objective_xgb(t, X_train, y_train, X_val, y_val), n_trials=10) # 10 trials for speed
        
        print(f"[OPTI] Best Optuna Log-Loss: {study_xgb.best_value:.4f}")
        best_params = study_xgb.best_params
    except Exception as e:
        print(f"[WARN] Optuna failed ({e}), falling back to default params.")
        best_params = {
            'learning_rate': 0.05, 'max_depth': 6, 'subsample': 0.8,
            'colsample_bytree': 0.8, 'n_estimators': 300
        }
    
    best_params['objective'] = 'multi:softprob'
    best_params['num_class'] = 3
    best_xgb = xgb.XGBClassifier(**best_params)
    
    # [CLASS IMBALANCE FIX] Compute weights so Away Wins and Draws teach the model equally
    weights = compute_sample_weight(class_weight='balanced', y=y_train)
    
    # We also use a validation set for early stopping during the final fit
    best_xgb.fit(
        X_train, y_train, 
        sample_weight=weights, 
        eval_set=[(X_val, y_val)], 
        verbose=False, 
        early_stopping_rounds=20
    )
    
    # 4. Accuracy Assessment
    y_pred = np.argmax(best_xgb.predict_proba(X_test), axis=1)
    acc = accuracy_score(y_test, y_pred)
    print(f"[MODEL] V24 Top Analyst XGBoost Accuracy: {acc*100:.2f}%")
    
    # 5. Save Model
    best_xgb.save_model(MODEL_XGB_PATH)
    print(f"[DISK] V24 Model saved successfully at {os.path.basename(MODEL_XGB_PATH)}")
    
    # 6. SHAP Explanability Update for V24 Dashboard
    try:
        print("[SHAP] Generating SHAP Explainer for V24 variables...")
        explainer = shap.Explainer(best_xgb)
        joblib.dump(explainer, SHAP_EXPLAINER_PATH)
        print("[SHAP] Explainer dumped successfully.")
        
        # Display Top 10 features natively
        shap_values = explainer(X_train.head(500))
        mean_abs_shap = np.abs(shap_values.values).mean(axis=(0, 2))
        top_indices = np.argsort(mean_abs_shap)[::-1][:10]
        print("\n[TOP10] TOP 10 INFLUENCERS IN V24 MODEL")
        for idx in top_indices:
            print(f"   -> {FEATURE_NAMES_V24[idx]} (Importance: {mean_abs_shap[idx]:.4f})")
    except Exception as e:
        print("[WARN] SHAP evaluation skipped or failed: ", e)

if __name__ == "__main__":
    run_v24_upgrade()
