import sqlite3
import pandas as pd
import numpy as np
import xgboost as xgb
import json
import os
from sklearn.model_selection import train_test_split, GridSearchCV
from sklearn.metrics import accuracy_score, log_loss
from ml_features import extract_ml_features, FEATURE_NAMES

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'historical_archive.sqlite')
MODEL_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'stitch_v19_titanium.json')

def load_training_data(limit=15000):
    if not os.path.exists(DB_PATH):
        print(f"Error: Archive DB not found at {DB_PATH}")
        return None
    
    conn = sqlite3.connect(DB_PATH)
    query = f"SELECT * FROM archive_matches WHERE stats_blob IS NOT NULL ORDER BY id DESC LIMIT {limit}"
    df_raw = pd.read_sql(query, conn)
    conn.close()
    
    data = []
    labels = []
    
    for _, row in df_raw.iterrows():
        # Feature extraction
        feats = extract_ml_features(row, fetch_history=False)
        data.append([feats.get(f, 0) for f in FEATURE_NAMES])
        
        # Labeling: 0=Home Win, 1=Draw, 2=Away Win
        hg = row['scoreHome']
        ag = row['scoreAway']
        if hg > ag: labels.append(0)
        elif hg == ag: labels.append(1)
        else: labels.append(2)
        
    return np.array(data), np.array(labels)

def augment_data(X, y, noise_level=0.02):
    """
    Data Augmentation: Injects small random noise into features 
    to make the model more robust to data variability.
    """
    X_aug = X.copy()
    noise = np.random.normal(0, noise_level, X_aug.shape)
    X_aug = X_aug + (X_aug * noise)
    return np.vstack([X, X_aug]), np.concatenate([y, y])

def train_ultra():
    print("Starting Titanium Ultra v16.0 Training...")
    
    X, y = load_training_data()
    if X is None or len(X) < 100:
        print("❌ Error: Insufficient training data.")
        return
    
    # Augment
    X, y = augment_data(X, y)
    print(f"Training on {len(X)} samples with {X.shape[1]} features.")
    
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    # XGBoost Hyperparameter Tuning
    model = xgb.XGBClassifier(
        objective='multi:softprob',
        num_class=3,
        eval_metric='mlogloss'
    )
    
    param_grid = {
        'max_depth': [4, 6, 8],
        'learning_rate': [0.01, 0.05, 0.1],
        'n_estimators': [100, 200],
        'subsample': [0.8, 1.0]
    }
    
    print("Tuning hyperparameters (GridSearch)...")
    grid = GridSearchCV(model, param_grid, cv=3, scoring='accuracy')
    grid.fit(X_train, y_train)
    
    best_model = grid.best_estimator_
    print(f"Best Params: {grid.best_params_}")
    
    # Evaluation
    preds = best_model.predict(X_test)
    probs = best_model.predict_proba(X_test)
    
    acc = accuracy_score(y_test, preds)
    ll = log_loss(y_test, probs)
    
    print(f"🎯 Accuracy: {acc:.4f}")
    print(f"📉 Log Loss: {ll:.4f}")
    
    # Save Model
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    best_model.save_model(MODEL_PATH)
    print(f"Model saved to: {MODEL_PATH}")

if __name__ == "__main__":
    train_ultra()
