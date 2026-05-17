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
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import accuracy_score, log_loss
from tensorflow.keras.models import Sequential, load_model
from tensorflow.keras.layers import Dense, Dropout
from tensorflow.keras.optimizers import Adam
from ml_features import extract_ml_features, FEATURE_NAMES

# Paths
BASE_DIR = os.path.dirname(os.path.dirname(__file__))
DB_PATH = os.path.join(BASE_DIR, 'data', 'historical_archive.sqlite')
MODEL_XGB_PATH = os.path.join(BASE_DIR, 'models', 'stitch_v23_hybrid.json')
MODEL_NN_PATH = os.path.join(BASE_DIR, 'models', 'stitch_v23_nn.h5')
SCALER_PATH = os.path.join(BASE_DIR, 'models', 'scaler_v23.pkl')
SHAP_EXPLAINER_PATH = os.path.join(BASE_DIR, 'models', 'shap_explainer_v23.pkl')

def load_data(limit=15000):
    conn = sqlite3.connect(DB_PATH)
    df = pd.read_sql(f"SELECT * FROM archive_matches WHERE stats_blob IS NOT NULL LIMIT {limit}", conn)
    conn.close()
    
    data, labels = [], []
    for _, row in df.iterrows():
        try:
            feats = extract_ml_features(row, fetch_history=False)
            data.append([feats.get(f, 0) for f in FEATURE_NAMES])
            hg, ag = row['scoreHome'], row['scoreAway']
            if hg > ag: labels.append(0)
            elif hg == ag: labels.append(1)
            else: labels.append(2)
        except: continue
        
    return pd.DataFrame(data, columns=FEATURE_NAMES), np.array(labels)

def objective_xgb(trial, X_train, y_train, X_val, y_val):
    params = {
        'objective': 'multi:softprob',
        'num_class': 3,
        'learning_rate': trial.suggest_float('learning_rate', 0.01, 0.3),
        'max_depth': trial.suggest_int('max_depth', 3, 10),
        'subsample': trial.suggest_float('subsample', 0.5, 1.0),
        'colsample_bytree': trial.suggest_float('colsample_bytree', 0.5, 1.0),
        'n_estimators': trial.suggest_int('n_estimators', 50, 500)
    }
    model = xgb.XGBClassifier(**params)
    model.fit(X_train, y_train)
    preds = model.predict_proba(X_val)
    return log_loss(y_val, preds)

def train_nn(X_train, y_train, X_val, y_val, params):
    model = Sequential([
        Dense(params['units1'], activation='relu', input_shape=(X_train.shape[1],)),
        Dropout(params['dropout1']),
        Dense(params['units2'], activation='relu'),
        Dropout(params['dropout2']),
        Dense(3, activation='softmax')
    ])
    model.compile(optimizer=Adam(learning_rate=params['lr']), loss='sparse_categorical_crossentropy', metrics=['accuracy'])
    model.fit(X_train, y_train, validation_data=(X_val, y_val), epochs=50, batch_size=32, verbose=0)
    return model

class HybridModel:
    def __init__(self, xgb_model, nn_model, scaler):
        self.xgb = xgb_model
        self.nn = nn_model
        self.scaler = scaler
        self.w_xgb = 0.5
        self.w_nn = 0.5

    def predict_proba(self, X):
        X_scaled = self.scaler.transform(X)
        p_xgb = self.xgb.predict_proba(X)
        p_nn = self.nn.predict(X_scaled, verbose=0)
        return (p_xgb * self.w_xgb) + (p_nn * self.w_nn)

def incremental_update(X_new, y_new):
    """
    Online Learning: Updates existing models with new data (Big Data Stream).
    """
    print("🔄 [ONLINE] Performing incremental update on V23 Hybrid hemisphers...")
    
    # 1. Update XGBoost (using existing booster as base)
    if os.path.exists(MODEL_XGB_PATH):
        old_xgb = xgb.Booster()
        old_xgb.load_model(MODEL_XGB_PATH)
        dnew = xgb.DMatrix(X_new, label=y_new, feature_names=FEATURE_NAMES)
        updated_xgb = xgb.train({'objective': 'multi:softprob', 'num_class': 3}, dnew, num_boost_round=10, xgb_model=old_xgb)
        updated_xgb.save_model(MODEL_XGB_PATH)
        print("✅ XGBoost hemisphere updated online.")
        
    # 2. Update Neural Network
    if os.path.exists(MODEL_NN_PATH):
        nn = load_model(MODEL_NN_PATH)
        scaler = joblib.load(SCALER_PATH)
        X_new_s = scaler.transform(X_new)
        nn.fit(X_new_s, y_new, epochs=5, batch_size=16, verbose=0)
        nn.save(MODEL_NN_PATH)
        print("✅ Neural Network hemisphere updated online.")

def run_v23_upgrade():
    # ... existing code ...
    print("🚀 [V23] Starting Hybrid Big Data AutoML Upgrade...")
    X, y = load_data()
    X_train, X_temp, y_train, y_temp = train_test_split(X, y, test_size=0.3, random_state=42)
    X_val, X_test, y_val, y_test = train_test_split(X_temp, y_temp, test_size=0.5, random_state=42)
    
    # 1. Optimize XGB
    print("🔍 Optimizing XGBoost with Optuna...")
    study_xgb = optuna.create_study(direction='minimize')
    study_xgb.optimize(lambda t: objective_xgb(t, X_train, y_train, X_val, y_val), n_trials=20)
    best_xgb = xgb.XGBClassifier(**study_xgb.best_params)
    best_xgb.fit(X_train, y_train)
    
    # 2. Train NN
    print("🧠 Training Neural Network hemisphers...")
    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_val_s = scaler.transform(X_val)
    nn_params = {'units1': 128, 'units2': 64, 'dropout1': 0.2, 'dropout2': 0.1, 'lr': 0.001}
    best_nn = train_nn(X_train_s, y_train, X_val_s, y_val, nn_params)
    
    # 3. Create Hybrid
    hybrid = HybridModel(best_xgb, best_nn, scaler)
    
    # 4. Accuracy Assessment
    y_pred = np.argmax(hybrid.predict_proba(X_test), axis=1)
    acc = accuracy_score(y_test, y_pred)
    print(f"✅ V23 Hybrid Accuracy: {acc*100:.2f}%")
    
    # 5. SHAP Explanability
    print("🔮 Generating SHAP Explainer (Global Patterns)...")
    # Using XGB for SHAP as it's faster and usually represents the logic well in a hybrid
    explainer = shap.Explainer(best_xgb)
    joblib.dump(explainer, SHAP_EXPLAINER_PATH)
    
    # 6. Save Everything
    best_xgb.save_model(MODEL_XGB_PATH)
    best_nn.save(MODEL_NN_PATH)
    joblib.dump(scaler, SCALER_PATH)
    print(f"💾 Models and Scaler saved at {os.path.dirname(MODEL_XGB_PATH)}")

if __name__ == "__main__":
    run_v23_upgrade()
