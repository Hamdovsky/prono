import os
import joblib
import xgboost as xgb
import json
import sys

# Paths from prediction_engine.py
XGB_MODEL_PATH = os.path.join('models', 'stitch_v6_ultra.json')
DNN_MODEL_PATH = os.path.join('models', 'stitch_deep_prime.pkl')
SCALER_PATH = os.path.join('data', 'neural_data', 'scaler_dnn.pkl')

print("🔍 [DIAGNOSTIC] Checking Model Files...")
print(f"XGB Path: {XGB_MODEL_PATH} -> {'Found' if os.path.exists(XGB_MODEL_PATH) else 'Missing'}")
print(f"DNN Path: {DNN_MODEL_PATH} -> {'Found' if os.path.exists(DNN_MODEL_PATH) else 'Missing'}")
print(f"Scaler Path: {SCALER_PATH} -> {'Found' if os.path.exists(SCALER_PATH) else 'Missing'}")

try:
    if os.path.exists(XGB_MODEL_PATH):
        booster = xgb.XGBClassifier()
        booster.load_model(XGB_MODEL_PATH)
        print("✅ XGBoost Model: Loaded Successfully")
except Exception as e:
    print(f"❌ XGBoost Error: {e}")

try:
    if os.path.exists(DNN_MODEL_PATH):
        dnn = joblib.load(DNN_MODEL_PATH)
        print("✅ DNN Model: Loaded Successfully")
except Exception as e:
    print(f"❌ DNN Error: {e}")

try:
    if os.path.exists(SCALER_PATH):
        scaler = joblib.load(SCALER_PATH)
        print("✅ Scaler: Loaded Successfully")
except Exception as e:
    print(f"❌ Scaler Error: {e}")

print("\n🚀 [SYSTEM CHECK] Environment Info:")
print(f"Python: {sys.version}")
try:
    import sklearn
    print(f"sklearn: {sklearn.__version__}")
except: print("sklearn: NOT FOUND")

try:
    import numpy
    print(f"numpy: {numpy.__version__}")
except: print("numpy: NOT FOUND")
