import sqlite3
import pandas as pd
import numpy as np
import xgboost as xgb
import json
import os
import optuna
import joblib
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_squared_error, mean_absolute_error

# Use the exact extraction logic we just updated
from ml_features import extract_ml_features, FEATURE_NAMES

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'historical_archive.sqlite')
MODEL_CORNERS_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'stitch_corners_v1.json')
MODEL_CARDS_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'stitch_cards_v1.json')

def load_data(limit=15000):
    print(f"📥 Loading up to {limit} historical matches from archive...")
    conn = sqlite3.connect(DB_PATH)
    df_raw = pd.read_sql(
        f"SELECT * FROM archive_matches WHERE stats_blob IS NOT NULL ORDER BY id DESC LIMIT {limit}",
        conn
    )
    conn.close()

    data = []
    y_corners = []
    y_cards = []

    for _, row in df_raw.iterrows():
        try:
            # Read corners from dedicated columns (archive schema has home_corners/away_corners)
            home_corners_actual = float(row.get('home_corners') or 0)
            away_corners_actual = float(row.get('away_corners') or 0)
            
            # Read cards from stats_blob (flat JSON object format)
            home_cards_actual = 0
            away_cards_actual = 0
            stats_raw = row.get('stats_blob')
            if stats_raw:
                stats = json.loads(stats_raw) if isinstance(stats_raw, str) else stats_raw
                if isinstance(stats, dict):
                    home_cards_actual = float(stats.get('yellow_cards_home', 0)) + float(stats.get('red_cards_home', 0)) * 2
                    away_cards_actual = float(stats.get('yellow_cards_away', 0)) + float(stats.get('red_cards_away', 0)) * 2

            # Skip matches with 0 corners total (highly likely missing data)
            if (home_corners_actual + away_corners_actual) == 0:
                continue
                
            feats = extract_ml_features(row, fetch_history=False)
            data.append([feats.get(f, np.nan) for f in FEATURE_NAMES])
            
            # Target is the total sum in the match (Easier to predict Over/Under)
            total_corners = home_corners_actual + away_corners_actual
            total_cards = home_cards_actual + away_cards_actual
            
            y_corners.append(total_corners)
            y_cards.append(total_cards)
            
        except Exception:
            continue

    X = pd.DataFrame(data, columns=FEATURE_NAMES)
    y_cor = pd.Series(y_corners)
    y_car = pd.Series(y_cards)
    
    # Impute missing
    X.fillna(X.median(), inplace=True)
    
    print(f"✅ Extracted {len(X)} valid training matches.")
    return X, y_cor, y_car

def objective_reg(trial, X_train, y_train, X_val, y_val):
    params = {
        'objective': 'reg:squarederror',
        'eval_metric': 'mae',
        'learning_rate': trial.suggest_float('learning_rate', 0.01, 0.2),
        'max_depth': trial.suggest_int('max_depth', 3, 9),
        'subsample': trial.suggest_float('subsample', 0.6, 1.0),
        'colsample_bytree': trial.suggest_float('colsample_bytree', 0.6, 1.0),
        'n_estimators': trial.suggest_int('n_estimators', 100, 500),
        'early_stopping_rounds': 15
    }
    model = xgb.XGBRegressor(**params)
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
    preds = model.predict(X_val)
    return mean_absolute_error(y_val, preds)

def train_regressor(X, y, name, save_path):
    print(f"\n⚙️ Training Regressor for: {name}")
    X_train, X_temp, y_train, y_temp = train_test_split(X, y, test_size=0.3, random_state=42)
    X_val, X_test, y_val, y_test = train_test_split(X_temp, y_temp, test_size=0.5, random_state=42)
    
    # Optuna optimization
    print(f"🔍 Optimizing {name} with Optuna...")
    try:
        optuna.logging.set_verbosity(optuna.logging.WARNING)
        study = optuna.create_study(direction='minimize')
        study.optimize(lambda t: objective_reg(t, X_train, y_train, X_val, y_val), n_trials=10)
        print(f"   Best MAE: {study.best_value:.2f}")
        best_params = study.best_params
    except Exception as e:
        print(f"   Optuna failed ({e}), using defaults")
        best_params = {
            'learning_rate': 0.08, 'max_depth': 5, 'subsample': 0.8,
            'colsample_bytree': 0.8, 'n_estimators': 150
        }
    
    best_params['objective'] = 'reg:squarederror'
    best_params['early_stopping_rounds'] = 20
    model = xgb.XGBRegressor(**best_params)
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
    
    preds = model.predict(X_test)
    rmse = np.sqrt(mean_squared_error(y_test, preds))
    mae = mean_absolute_error(y_test, preds)
    
    print(f"🎯 {name} MAE (Average Error): ±{mae:.2f}")
    print(f"🎯 {name} RMSE: {rmse:.2f}")
    
    # Save the model (use booster to avoid sklearn wrapper bug)
    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    model.get_booster().save_model(save_path)
    print(f"💾 Model saved to: {save_path}")

def main():
    X, y_cor, y_car = load_data()
    if X is None or len(X) < 100:
        print("❌ Not enough data to train.")
        return
        
    train_regressor(X, y_cor, "Total Match Corners", MODEL_CORNERS_PATH)
    train_regressor(X, y_car, "Total Match Cards (Severity Index)", MODEL_CARDS_PATH)

if __name__ == "__main__":
    main()
