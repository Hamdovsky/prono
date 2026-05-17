import sqlite3
import json
import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, confusion_matrix, classification_report
import os
import sys

# --- Paths ---
DB_PATH = os.path.join(os.path.dirname(__file__), 'data', 'historical_archive.sqlite')
MODELS_DIR = os.path.join(os.path.dirname(__file__), 'models')
MODEL_FILENAME = 'stitch_v1.json'
MODEL_PATH = os.path.join(MODELS_DIR, MODEL_FILENAME)

# Create models directory if not exists
if not os.path.exists(MODELS_DIR):
    os.makedirs(MODELS_DIR)

def clean_val(val):
    if isinstance(val, str):
        try:
            # Handle percentage strings like "55%" or "60/40"
            clean = val.replace('%', '').split('/')[0].strip()
            return float(clean)
        except (ValueError, IndexError):
            return 0.0
    return float(val) if val is not None else 0.0

def extract_features(stats_json):
    if not stats_json or stats_json == '[]':
        return {}
    
    try:
        stats = json.loads(stats_json)
        features = {}
        # Keys to extract based on user prompt and common stats
        mapping = {
            'Ball possession': 'possession',
            'Total shots': 'shots',
            'Shots on target': 'shots_on_target',
            'Expected goals': 'xg',
            'Big chances': 'big_chances',
            'Corners': 'corners',
            'Yellow cards': 'yellow_cards',
            'Red cards': 'red_cards'
        }
        
        for item in stats:
            cat = item.get('category', item.get('name', 'Unknown'))
            if cat in mapping:
                feat_name = mapping[cat]
                features[f"{feat_name}_home"] = clean_val(item.get('homeValue', item.get('home', 0)))
                features[f"{feat_name}_away"] = clean_val(item.get('awayValue', item.get('away', 0)))
        
        return features
    except Exception as e:
        return {}

def train_model():
    print("🚀 Starting XGBoost Training Pipeline...")
    
    if not os.path.exists(DB_PATH):
        print(f"❌ Error: Database not found at {DB_PATH}")
        sys.exit(1)
        
    # 1. Load Data
    print(f"📦 Loading data from {DB_PATH}...")
    conn = sqlite3.connect(DB_PATH)
    query = "SELECT stats_blob, scoreHome, scoreAway FROM archive_matches WHERE stats_blob IS NOT NULL"
    df_raw = pd.read_sql_query(query, conn)
    conn.close()
    
    if df_raw.empty:
        print("❌ Error: No data found in archive_matches.")
        sys.exit(1)
    
    print(f"📊 Processing {len(df_raw)} matches...")
    
    # 2. Extract Features
    features_list = []
    targets = []
    
    for _, row in df_raw.iterrows():
        feats = extract_features(row['stats_blob'])
        if not feats:
            continue
            
        # Target: 0 = Home Win, 1 = Draw, 2 = Away Win
        sh = row['scoreHome']
        sa = row['scoreAway']
        if sh is None or sa is None:
            continue
            
        if sh > sa:
            target = 0
        elif sh == sa:
            target = 1
        else:
            target = 2
            
        features_list.append(feats)
        targets.append(target)
        
    X = pd.DataFrame(features_list)
    y = np.array(targets)
    
    # Handle missing values (fill with 0 for now)
    X = X.fillna(0)
    
    if X.empty:
        print("❌ Error: No features extracted. Check stats_blob format.")
        sys.exit(1)
        
    print(f"✅ Extracted {len(X.columns)} features: {list(X.columns)}")
    print(f"📈 Class Distribution: {pd.Series(y).value_counts().to_dict()}")
    
    # 3. Split Data
    # Ensure stratify if possible to keep class balance
    try:
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)
    except:
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    # 4. Train Model
    print("🧠 Training XGBoost Classifier...")
    # Use Booster internal save format (JSON)
    model = xgb.XGBClassifier(
        n_estimators=100,
        max_depth=5,
        learning_rate=0.05,
        objective='multi:softprob',
        num_class=3,
        random_state=42,
        eval_metric='mlogloss'
    )
    
    model.fit(X_train, y_train)
    
    # 5. Evaluate
    print("\n--- 📈 Evaluation Report ---")
    y_pred = model.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    print(f"Accuracy: {acc:.2%}")
    
    print("\nConfusion Matrix:")
    print(confusion_matrix(y_test, y_pred))
    
    # Dynamically determine labels present in test set for report
    unique_labels = sorted(np.unique(np.concatenate((y_test, y_pred))))
    target_names_all = ['Home Win', 'Draw', 'Away Win']
    target_names = [target_names_all[i] for i in unique_labels]
    
    print("\nClassification Report:")
    print(classification_report(y_test, y_pred, labels=unique_labels, target_names=target_names))
    
    # 6. Save Model
    print(f"\n💾 Saving model to {MODEL_PATH}...")
    model.save_model(MODEL_PATH)
    print("✨ Training Complete! System will now use 'Stitch-V1' engine.")

if __name__ == "__main__":
    train_model()
