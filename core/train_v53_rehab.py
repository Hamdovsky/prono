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

# Ensure paths correctly resolve to the core functionality
import sys
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from ml_features import extract_ml_features, FEATURE_NAMES_V52
from top_analyst_engine import process_match_for_top_analyst

# Paths
BASE_DIR = os.path.dirname(os.path.dirname(__file__))
DB_PATH = os.path.join(BASE_DIR, 'data', 'historical_archive.sqlite')
MODEL_XGB_PATH = os.path.join(BASE_DIR, 'models', 'stitch_v24_hybrid.json') # Same file to replace
SHAP_EXPLAINER_PATH = os.path.join(BASE_DIR, 'models', 'shap_explainer_v24.pkl')

def build_match_payload_from_row(row, base_feats):
    row_dict = dict(row)
    match = {
        'id': row_dict.get('sofascore_id'),
        'homeTeam': row_dict.get('homeTeam', 'Unknown'),
        'awayTeam': row_dict.get('awayTeam', 'Unknown'),
        'league': row_dict.get('tournament_name', 'Unknown'),
        'odds_home': row_dict.get('odds_home') or base_feats.get('odds_h', 2.0),
        'odds_draw': row_dict.get('odds_draw') or 3.0,
        'odds_away': row_dict.get('odds_away') or base_feats.get('odds_a', 3.0),
        'home_xg': base_feats.get('h_xg', 0),
        'away_xg': base_feats.get('a_xg', 0),
        'player_ratings_home': row_dict.get('player_ratings_home', '[]'),
        'player_ratings_away': row_dict.get('player_ratings_away', '[]'),
        'stats': json.loads(row_dict.get('stats_blob', '[]')),
        'h2h_data': row_dict.get('h2h_data'),
        'odds_movement_24h': row_dict.get('odds_movement_24h')
    }
    return match

def load_data(limit=30000):
    print(f"[V53] Loading historical data for REHAB (V51/V52 Features Active)...")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    df = pd.read_sql(f"SELECT * FROM archive_matches WHERE scoreHome IS NOT NULL LIMIT {limit}", conn)
    conn.close()
    
    data, labels = [], []
    valid_matches = 0
    
    for i, row in df.iterrows():
        try:
            row_dict = dict(row)
            # 1. Extract base features while passing the row which now has h2h_data etc.
            base_feats = extract_ml_features(row_dict, fetch_history=False)
            
            # 2. Build pseudo-live match payload for Top Analyst
            match_payload = build_match_payload_from_row(row, base_feats)
            
            # 3. Process through Top Analyst to get the market/sentiment features
            ta_result = process_match_for_top_analyst(match_payload)
            ta_feats = ta_result.get('ml_features', {})
            
            # 4. Merge dictionaries
            full_feats = {**base_feats, **ta_feats}
            
            # 5. Extract strictly by FEATURE_NAMES_V52 ordering
            row_vector = [full_feats.get(f, 0.0) for f in FEATURE_NAMES_V52]
            data.append(row_vector)
            
            # 6. Generate labels (0: Home, 1: Draw, 2: Away)
            hg, ag = row['scoreHome'], row['scoreAway']
            if hg > ag: labels.append(0)
            elif hg == ag: labels.append(1)
            else: labels.append(2)
            
            valid_matches += 1
            if valid_matches % 500 == 0:
                print(f"   ... Processed {valid_matches} records.")
                
        except Exception as e:
            continue
            
    print(f"[STATS] Extracted {valid_matches} rows with {len(FEATURE_NAMES_V52)} features.")
    return pd.DataFrame(data, columns=FEATURE_NAMES_V52), np.array(labels)

def run_v53_training():
    print("[REHAB] Starting V53 Market & H2H Intelligence Model Training...")
    
    X, y = load_data()
    if len(X) < 100:
        print("[FAIL] Not enough data to train V53.")
        return
        
    X_train, X_temp, y_train, y_temp = train_test_split(X, y, test_size=0.3, random_state=42)
    X_val, X_test, y_val, y_test = train_test_split(X_temp, y_temp, test_size=0.5, random_state=42)
    
    print("[OPTI] Tuning V53 features with XGBoost...")
    # Standard high-performance params for XGBoost (skipping Optuna for speed during reboot)
    best_params = {
        'objective': 'multi:softprob', 'num_class': 3,
        'learning_rate': 0.03, 'max_depth': 7, 'subsample': 0.85,
        'colsample_bytree': 0.85, 'n_estimators': 450,
        'random_state': 42,
        'early_stopping_rounds': 50
    }
    
    best_xgb = xgb.XGBClassifier(**best_params)
    best_xgb.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)

    
    # 4. Accuracy Assessment
    y_pred = np.argmax(best_xgb.predict_proba(X_test), axis=1)
    acc = accuracy_score(y_test, y_pred)
    l_loss = log_loss(y_test, best_xgb.predict_proba(X_test))
    print(f"[MODEL] V53 REHAB Accuracy: {acc*100:.2f}% | Log Loss: {l_loss:.4f}")
    
    # 5. Save Model
    best_xgb.save_model(MODEL_XGB_PATH)
    print(f"[DISK] V53 Rehabilitated Model saved at {os.path.basename(MODEL_XGB_PATH)}")
    
    # 6. SHAP Explanability Update
    try:
        explainer = shap.Explainer(best_xgb)
        joblib.dump(explainer, SHAP_EXPLAINER_PATH)
        shap_values = explainer(X_train.head(500))
        mean_abs_shap = np.abs(shap_values.values).mean(axis=(0, 2))
        top_indices = np.argsort(mean_abs_shap)[::-1][:10]
        print("\n[V53-TOP10] TOP 10 INFLUENCERS (REHABILITATION BRAIN)")
        for idx in top_indices:
            print(f"   -> {FEATURE_NAMES_V52[idx]} (Importance: {mean_abs_shap[idx]:.4f})")
    except Exception as e:
        print("[WARN] SHAP error: ", e)

if __name__ == "__main__":
    run_v53_training()
