import sqlite3
import pandas as pd
import numpy as np
import xgboost as xgb
import os
import json
from sklearn.metrics import accuracy_score, log_loss, classification_report
from ml_features import extract_ml_features, FEATURE_NAMES

DB_PATH = os.path.join(os.path.dirname(__file__), 'data', 'tactical.db')
MODEL_SAVE = os.path.join(os.path.dirname(__file__), 'models', 'stitch_v3.json')

def determine_label(score_home, score_away):
    """0=Away win, 1=Draw, 2=Home win"""
    h, a = int(score_home or 0), int(score_away or 0)
    if h > a: return 2
    if h < a: return 0
    return 1

def main():
    print("=======================================================")
    print("  Stitch Model Training Pipeline — v3 (True ML)")
    print("=======================================================")

    dataset = []

    # Source: Tactical DB (finished matches with proper Pre-Match context)
    if os.path.exists(DB_PATH):
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        
        # We need historical context, news, forms, etc.
        rows = conn.execute("""
            SELECT id, homeTeam, awayTeam, scoreHome, scoreAway, fullData
            FROM matches
            WHERE status IN ('FT', 'Finished', 'finished', 'AET', 'PEN', 'Ended')
              AND scoreHome IS NOT NULL AND scoreAway IS NOT NULL
        """).fetchall()
        conn.close()
        
        print(f"[Tactical DB] Found {len(rows)} finished matches for training.")

        for row in rows:
            r_dict = dict(row)
            try:
                full_data = json.loads(r_dict.get('fullData', '{}'))
                if isinstance(full_data, dict):
                    for k, v in full_data.items():
                        if k not in r_dict:
                            r_dict[k] = v
            except:
                pass
            
            # True pre-match features instead of useless post-match possession stats
            feats = extract_ml_features(r_dict, fetch_history=True)
            if feats:
                feats['target'] = determine_label(r_dict['scoreHome'], r_dict['scoreAway'])
                dataset.append(feats)
    else:
        print(f"[ERROR] Tactical DB not found at {DB_PATH}")
        return

    if len(dataset) < 50:
        print(f"[ERROR] Not enough data ({len(dataset)} samples).")
        return

    df = pd.DataFrame(dataset).fillna(0)

    # Ensure order matches FEATURE_NAMES exactly
    X = df[FEATURE_NAMES]
    y = df['target']

    print(f"\n[DATA] Dataset shape: {X.shape}")
    print(f"   Label distribution:\n{y.value_counts().to_string()}")

    # Generate Gap Learning Dynamic Weights (emphasizing matches with professional variables)
    weights = np.ones(len(y))
    for i, row in df.iterrows():
        weight = 1.0
        if row.get('market_inefficiency_h', 0) > 1.5 or row.get('market_inefficiency_a', 0) > 1.5:
            weight += 1.5
        if abs(row.get('squad_rotation_impact', 0)) > 1.0:
            weight += 1.0
        if row.get('tactical_shift_volatility', 0) > 0.5:
            weight += 1.0
        weights[i] = weight

    # TEMPORAL split (no data leakage): 70% train (oldest), 15% val, 15% test (newest)
    n = len(X)
    train_end = int(n * 0.70)
    val_end = int(n * 0.85)

    X_train, y_train, w_train = X.iloc[:train_end], y.iloc[:train_end], weights[:train_end]
    X_val, y_val = X.iloc[train_end:val_end], y.iloc[train_end:val_end]
    X_test, y_test = X.iloc[val_end:], y.iloc[val_end:]

    print(f"\n[SPLIT] Temporal: train={len(X_train)} val={len(X_val)} test={len(X_test)}")

    model = xgb.XGBClassifier(
        objective='multi:softprob',
        num_class=3,
        eval_metric=['mlogloss', 'merror'],
        learning_rate=0.05,
        max_depth=4,
        n_estimators=200,
        subsample=0.85,
        colsample_bytree=0.85,
        random_state=42,
        tree_method='hist',
        early_stopping_rounds=15,
    )

    print("\n[MODEL] Training XGBoost v3 Classifier on Pre-Match Features (Gap Learning + Temporal Split)...")
    model.fit(
        X_train, y_train,
        sample_weight=w_train,
        eval_set=[(X_val, y_val)],
        verbose=False
    )

    y_pred = model.predict(X_test)
    y_prob = model.predict_proba(X_test)
    accuracy = accuracy_score(y_test, y_pred)
    loss = log_loss(y_test, y_prob)

    print("\n========================================")
    print("  EVALUATION RESULTS (Temporal Test Set):")
    print(f"   Accuracy  : {accuracy:.4f} ({accuracy*100:.1f}%)")
    print(f"   Log-Loss  : {loss:.4f}")
    print(f"   Best iter : {model.best_iteration}")
    print("\n  Classification Report:")
    print(classification_report(y_test, y_pred, target_names=['Away', 'Draw', 'Home']))
    print("========================================")

    model.save_model(MODEL_SAVE)
    print(f"\n[DONE] Model saved: {MODEL_SAVE}")

if __name__ == "__main__":
    main()
