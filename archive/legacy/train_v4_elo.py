import sqlite3
import pandas as pd
import json
import numpy as np
import os
import joblib
from xgboost import XGBClassifier
from ml_features import extract_ml_features, FEATURE_NAMES

DB_PATH = os.path.join(os.path.dirname(__file__), 'data', 'historical_archive.sqlite')
MODEL_PATH = os.path.join(os.path.dirname(__file__), 'models', 'stitch_v4_elo.json')

def train_v4():
    print("🚀 [Training V4] Elo + xG + XGBoost integration starting...")
    if not os.path.exists(DB_PATH):
        print(f"Error: Database not found at {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    
    # Fetch finished matches with stats
    query = """
    SELECT * FROM archive_matches 
    WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL 
    AND stats_blob IS NOT NULL
    LIMIT 2000
    """
    rows = conn.execute(query).fetchall()
    conn.close()
    
    if len(rows) < 50:
        print(f"Not enough data: {len(rows)} matches found.")
        return

    data_list = []
    targets = []
    
    print(f"Processing {len(rows)} matches...")
    for r in rows:
        row_dict = dict(r)
        # Target: 0_Away, 1_Draw, 2_Home
        sh, sa = r['scoreHome'], r['scoreAway']
        if sh > sa: target = 2
        elif sh < sa: target = 0
        else: target = 1
        
        feats = extract_ml_features(row_dict, fetch_history=False) # Use current row info if possible
        data_list.append(feats)
        targets.append(target)
        
    df = pd.DataFrame(data_list)
    df = df[FEATURE_NAMES].fillna(0)
    
    X = df.values
    y = np.array(targets)
    
    model = XGBClassifier(
        n_estimators=150,
        learning_rate=0.04,
        max_depth=5,
        objective='multi:softprob',
        num_class=3,
        random_state=42
    )
    
    print("Fitting model...")
    model.fit(X, y)
    
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    model.save_model(MODEL_PATH)
    print(f"✅ Model saved to {MODEL_PATH}")
    
    accuracy = model.score(X, y)
    print(f"🎯 Training Accuracy: {accuracy*100:.2f}%")

if __name__ == "__main__":
    train_v4()
