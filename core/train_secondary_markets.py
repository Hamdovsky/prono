import sqlite3
import pandas as pd
import numpy as np
import xgboost as xgb
import json
import os
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
            stats = json.loads(row['stats_blob'])
            
            # Ground Truth Extraction for Corners and Cards
            home_corners_actual = 0
            away_corners_actual = 0
            home_cards_actual = 0
            away_cards_actual = 0
            
            for item in stats:
                cat = item.get('category', 'Unknown')
                val_h = float(item.get('homeValue', 0) if str(item.get('homeValue', '0')).replace('.', '').isdigit() else 0)
                val_a = float(item.get('awayValue', 0) if str(item.get('awayValue', '0')).replace('.', '').isdigit() else 0)
                
                if cat == 'Corner kicks':
                    home_corners_actual = val_h
                    away_corners_actual = val_a
                elif cat == 'Yellow cards':
                    home_cards_actual += val_h
                    away_cards_actual += val_a
                elif cat == 'Red cards':
                    home_cards_actual += (val_h * 2) # Arbitrary weight mapping for regressor
                    away_cards_actual += (val_a * 2)

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

def train_regressor(X, y, name, save_path):
    print(f"\n⚙️ Training Regressor for: {name}")
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.15, random_state=42)
    
    model = xgb.XGBRegressor(
        objective='reg:squarederror',
        n_estimators=150,
        learning_rate=0.08,
        max_depth=5,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42,
        n_jobs=-1
    )
    
    model.fit(X_train, y_train)
    
    preds = model.predict(X_test)
    rmse = np.sqrt(mean_squared_error(y_test, preds))
    mae = mean_absolute_error(y_test, preds)
    
    print(f"🎯 {name} MAE (Average Error): ±{mae:.2f}")
    print(f"🎯 {name} RMSE: {rmse:.2f}")
    
    # Save the model
    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    model.save_model(save_path)
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
