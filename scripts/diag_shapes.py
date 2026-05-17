import sys
import os
import json
import numpy as np
import xgboost as xgb
import joblib

sys.path.insert(0, 'core')
from ml_features import FEATURE_NAMES, FEATURE_NAMES_V24

models_dir = 'models'

def check_xgb():
    path = os.path.join(models_dir, 'stitch_v24_hybrid.json')
    if os.path.exists(path):
        print(f"Checking XGB: {path}")
        b = xgb.Booster()
        b.load_model(path)
        d = xgb.DMatrix(np.zeros((1, len(FEATURE_NAMES_V24))), feature_names=FEATURE_NAMES_V24)
        p = b.predict(d)
        print(f"  XGB Pred Shape: {p.shape}")
        print(f"  XGB Pred Example: {p}")
        
        # Check contribs
        c = b.predict(d, pred_contribs=True)
        print(f"  XGB Contribs Shape: {c.shape}")

def check_nn():
    path = os.path.join(models_dir, 'stitch_v23_nn.h5')
    if os.path.exists(path):
        print(f"Checking NN: {path}")
        try:
            from tensorflow.keras.models import load_model
            m = load_model(path)
            p = m.predict(np.zeros((1, len(FEATURE_NAMES))), verbose=0)
            print(f"  NN Pred Shape: {p.shape}")
            print(f"  NN Pred Example: {p}")
        except Exception as e:
            print(f"  NN Load/Pred Error: {e}")

if __name__ == "__main__":
    check_xgb()
    check_nn()
