import sqlite3
import pandas as pd
import json
import numpy as np
import os
import joblib
from xgboost import XGBClassifier
from ml_features import extract_ml_features, FEATURE_NAMES

DB_PATH = os.path.join(os.path.dirname(__file__), 'data', 'historical_archive.sqlite')
MODEL_PATH = os.path.join(os.path.dirname(__file__), 'models', 'stitch_v5_pro.json')

def train_v5():
    print("🚀 [Training V5 PRO] Momentum + Injury + Elo integration starting...")
    if not os.path.exists(DB_PATH):
        print(f"Error: Database not found at {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    
    # Fetch data
    query = """
    SELECT * FROM archive_matches 
    WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL 
    AND stats_blob IS NOT NULL
    LIMIT 3000
    """
    rows = conn.execute(query).fetchall()
    conn.close()
    
    if len(rows) < 100:
        print(f"Not enough data: {len(rows)} matches found.")
        return

    data_list = []
    targets = []
    
    print(f"Processing {len(rows)} matches for PRO features...")
    for i, r in enumerate(rows):
        row_dict = dict(r)
        sh, sa = r['scoreHome'], r['scoreAway']
        if sh > sa: target = 2
        elif sh < sa: target = 0
        else: target = 1
        
        # In training, we fetch history for each row to build rolling averages correctly
        # This is slow but necessary for V5
        feats = extract_ml_features(row_dict, fetch_history=True)
        data_list.append(feats)
        targets.append(target)
        if i % 100 == 0: print(f"Progress: {i}/{len(rows)}")
        
    df = pd.DataFrame(data_list)
    df = df[FEATURE_NAMES].fillna(0)
    
    X = df.values
    y = np.array(targets)
    
    model = XGBClassifier(
        n_estimators=200,
        learning_rate=0.03,
        max_depth=6,
        objective='multi:softprob',
        num_class=3,
        random_state=42,
        subsample=0.8,
        colsample_bytree=0.8
    )
    
    print("Fitting PRO model...")
    model.fit(X, y)
    
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    model.save_model(MODEL_PATH)
    print(f"✅ Pro Model saved to {MODEL_PATH}")
    
    accuracy = model.score(X, y)
    print(f"🎯 Training Accuracy (Pro): {accuracy*100:.2f}%")

if __name__ == "__main__":
    train_v5()
