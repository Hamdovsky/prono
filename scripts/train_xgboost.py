import sqlite3
import pandas as pd
import json
import numpy as np
import os
import sys

# Add core to sys.path
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'core'))

try:
    from xgboost import XGBClassifier
    import joblib
    from ml_features import extract_ml_features, FEATURE_NAMES_TITANIUM
except ImportError as e:
    print(f"Import error: {e}")
    print("Please ensure xgboost, joblib, and pandas are installed.")
    exit(1)

# Correct Database Path
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'historical_archive.sqlite')
MODEL_PATH = os.path.join(os.path.dirname(__file__), '..', 'models', 'titanium_v2.json') 

# Ensure models directory exists
os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)

def load_training_data():
    if not os.path.exists(DB_PATH):
        print(f"Database not found at {DB_PATH}")
        return None

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    
    # We use archive_matches for a larger dataset (3000+ matches)
    query = """
    SELECT *
    FROM archive_matches 
    WHERE stats_blob IS NOT NULL 
    ORDER BY id DESC LIMIT 5000
    """
    df = pd.read_sql_query(query, conn)
    conn.close()
    return df

_count = 0
def extract_features_v2(row):
    global _count
    _count += 1
    if _count % 50 == 0:
        print(f"Progress: Extracted {_count} feature vectors...")
    
    # Convert row to dict
    row_dict = dict(row)
    
    # Target Label: 0 = Away Win, 1 = Draw, 2 = Home Win
    h_score = int(row['scoreHome'])
    a_score = int(row['scoreAway'])
    if h_score > a_score:
        target = 2
    elif h_score == a_score:
        target = 1
    else:
        target = 0

    # Use the official feature extraction logic
    # fetch_history=True is crucial for realistic momentum/form features
    features = extract_ml_features(row_dict, fetch_history=True)
    
    # Filter only the Titanium feature set
    final_features = {k: features.get(k, 0.0) for k in FEATURE_NAMES_TITANIUM}
    final_features['target'] = target
    
    return pd.Series(final_features)

def train_model():
    print("[TITANIUM-TRAIN] Starting Elite AI Retraining Cycle...")
    df = load_training_data()
    
    if df is None or len(df) < 5:
        print("Warning: Not enough data to train. Found {len(df) if df is not None else 0} matches. Need at least 20 for quality.")
        if df is not None and len(df) > 0:
            print("Proceeding with limited data for testing...")
        else:
            return

    print(f"Data: Processing {len(df)} matches for training...")
    
    # Extract features using the official logic
    features_df = df.apply(extract_features_v2, axis=1)
    
    X = features_df[FEATURE_NAMES_TITANIUM]
    y = features_df['target']

    print(f"Model: Training XGBoost with {len(FEATURE_NAMES_TITANIUM)} elite features...")
    
    model = XGBClassifier(
        n_estimators=150,
        learning_rate=0.03,
        max_depth=5,
        objective='multi:softprob',
        num_class=3,
        random_state=42,
        use_label_encoder=False,
        eval_metric='mlogloss'
    )
    
    model.fit(X, y)
    
    # Save model in JSON format (native XGBoost)
    model.get_booster().save_model(MODEL_PATH)
    print(f"DONE: Elite Model saved to {MODEL_PATH}")
    
    # Simple evaluation
    accuracy = model.score(X, y)
    print(f"Accuracy: {accuracy*100:.2f}%")

if __name__ == "__main__":
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(line_buffering=True)
    train_model()
