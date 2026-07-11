import sqlite3
import pandas as pd
import json
import numpy as np
import os
import sys
import optuna
from sklearn.metrics import accuracy_score, log_loss

sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'core'))

try:
    import xgboost as xgb
    from ml_features import extract_ml_features, FEATURE_NAMES_TITANIUM, FEATURE_VOLATILITY
except ImportError as e:
    print(f"Import error: {e}")
    sys.exit(1)

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'historical_archive.sqlite')
MODEL_PATH = os.path.join(os.path.dirname(__file__), '..', 'models', 'titanium_v2.json')

os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)


def load_training_data():
    if not os.path.exists(DB_PATH):
        print(f"Database not found at {DB_PATH}")
        return None
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    query = "SELECT * FROM archive_matches WHERE stats_blob IS NOT NULL AND scoreHome IS NOT NULL ORDER BY startTimestamp ASC"
    df = pd.read_sql_query(query, conn)
    conn.close()
    return df


_count = 0
def extract_features_v2(row):
    global _count
    _count += 1
    if _count % 100 == 0:
        print(f"Progress: Extracted {_count} feature vectors...")
    row_dict = dict(row)
    h_score = int(row['scoreHome'])
    a_score = int(row['scoreAway'])
    target = 2 if h_score > a_score else 1 if h_score == a_score else 0
    features = extract_ml_features(row_dict, fetch_history=True, current_match_ts=row['startTimestamp'])
    final_features = {k: features.get(k, 0.0) for k in FEATURE_NAMES_TITANIUM}
    final_features['target'] = target
    return pd.Series(final_features)


def noise_augment(X, y, noise_levels, rng=None):
    if rng is None:
        rng = np.random.default_rng(42)
    X_aug = X.copy()
    n_samples, n_features = X_aug.shape
    for i in range(min(n_features, len(noise_levels))):
        vol = noise_levels[i]
        if vol > 0:
            noise = rng.normal(0, vol, n_samples)
            mask = (X[:, i] != 0) & (X[:, i] != 1)
            X_aug[:, i] = np.where(mask, X[:, i] * (1.0 + noise), X[:, i])
    return np.vstack([X, X_aug]), np.concatenate([y, y])


def train_model():
    print("[TITANIUM V3] Training with TIME-BASED split...")
    df = load_training_data()
    if df is None or len(df) < 100:
        print(f"Not enough data: {len(df) if df is not None else 0}")
        return

    print(f"Data: {len(df)} matches (ordered by startTimestamp)")

    features_df = df.apply(extract_features_v2, axis=1)
    X = features_df[FEATURE_NAMES_TITANIUM]
    y = features_df['target']

    print(f"Features: {len(FEATURE_NAMES_TITANIUM)} Titanium V3 features")

    # Time-based split: 70% train (oldest), 15% val, 15% test (newest)
    n = len(X)
    train_end = int(n * 0.70)
    val_end = int(n * 0.85)

    X_train = X.iloc[:train_end]
    y_train = y.iloc[:train_end]

    X_val = X.iloc[train_end:val_end]
    y_val = y.iloc[train_end:val_end]

    X_test = X.iloc[val_end:]
    y_test = y.iloc[val_end:]

    print(f"Split: train={len(X_train)} val={len(X_val)} test={len(X_test)}")
    print(f"Date ranges:")
    print(f"  Train: {pd.to_datetime(df.iloc[0]['startTimestamp'], unit='s')} to {pd.to_datetime(df.iloc[train_end-1]['startTimestamp'], unit='s')}")
    print(f"  Val:   {pd.to_datetime(df.iloc[train_end]['startTimestamp'], unit='s')} to {pd.to_datetime(df.iloc[val_end-1]['startTimestamp'], unit='s')}")
    print(f"  Test:  {pd.to_datetime(df.iloc[val_end]['startTimestamp'], unit='s')} to {pd.to_datetime(df.iloc[-1]['startTimestamp'], unit='s')}")

    X_val_np = X_val.values
    y_val_np = y_val.values
    X_test_np = X_test.values
    y_test_np = y_test.values

    noise_levels = [FEATURE_VOLATILITY.get(f, 0.05) for f in FEATURE_NAMES_TITANIUM]
    X_train_aug, y_train_aug = noise_augment(X_train.values, y_train, noise_levels)
    print(f"Augmented: {len(X_train)} -> {len(X_train_aug)}")

    print("Optimizing with Optuna...")

    def objective(trial):
        params = {
            'objective': 'multi:softprob',
            'num_class': 3,
            'eval_metric': 'mlogloss',
            'learning_rate': trial.suggest_float('learning_rate', 0.005, 0.06, log=True),
            'max_depth': trial.suggest_int('max_depth', 4, 10),
            'subsample': trial.suggest_float('subsample', 0.65, 0.95),
            'colsample_bytree': trial.suggest_float('colsample_bytree', 0.65, 0.95),
            'min_child_weight': trial.suggest_int('min_child_weight', 1, 6),
            'reg_alpha': trial.suggest_float('reg_alpha', 0.0, 1.0),
            'reg_lambda': trial.suggest_float('reg_lambda', 0.0, 2.0),
            'n_estimators': trial.suggest_int('n_estimators', 300, 700),
            'random_state': 42
        }
        model = xgb.XGBClassifier(**params)
        model.fit(X_train_aug, y_train_aug, eval_set=[(X_val_np, y_val_np)], verbose=False)
        return log_loss(y_val_np, model.predict_proba(X_val_np))

    study = optuna.create_study(direction='minimize', sampler=optuna.samplers.TPESampler(seed=42))
    study.optimize(objective, n_trials=50, show_progress_bar=True)

    best_params = study.best_params
    best_params.update({'objective': 'multi:softprob', 'num_class': 3, 'eval_metric': 'mlogloss', 'random_state': 42})
    print(f"Best params: {best_params}")

    model = xgb.XGBClassifier(**best_params)
    model.fit(X_train_aug, y_train_aug, eval_set=[(X_val_np, y_val_np)], verbose=False)

    y_pred = np.argmax(model.predict_proba(X_test_np), axis=1)
    acc = accuracy_score(y_test_np, y_pred)
    ll = log_loss(y_test_np, model.predict_proba(X_test_np))
    print(f"\n=== TIME-BASED TEST SET RESULTS ===")
    print(f"Accuracy: {acc*100:.2f}% | Log Loss: {ll:.4f}")
    print(f"Test size: {len(y_test)} matches")

    # Per-class accuracy
    from sklearn.metrics import classification_report
    print("\nClassification Report:")
    print(classification_report(y_test_np, y_pred, target_names=['Away', 'Draw', 'Home']))

    model.get_booster().save_model(MODEL_PATH)
    print(f"\nSaved: {MODEL_PATH}")

    # Feature importance (top 15)
    importances = model.feature_importances_
    feat_imp = sorted(zip(FEATURE_NAMES_TITANIUM, importances), key=lambda x: x[1], reverse=True)
    print("\nTop 15 Feature Importance:")
    for name, imp in feat_imp[:15]:
        print(f"  {name:40s} {imp:.4f}")

    # Walk-forward cross-validation (5 folds, temporal)
    print("\n[CV] Walk-Forward Cross-Validation (5 folds)...")
    from sklearn.model_selection import TimeSeriesSplit
    tscv = TimeSeriesSplit(n_splits=5)
    X_all = np.vstack([X_train_aug, X_val_np, X_test_np])
    y_all = np.concatenate([y_train_aug, y_val_np, y_test_np])
    cv_scores = []
    for fold, (train_idx, test_idx) in enumerate(tscv.split(X_all)):
        cv_model = xgb.XGBClassifier(**best_params)
        cv_model.fit(X_all[train_idx], y_all[train_idx], verbose=False)
        cv_pred = cv_model.predict_proba(X_all[test_idx])
        cv_ll = log_loss(y_all[test_idx], cv_pred)
        cv_acc = accuracy_score(y_all[test_idx], np.argmax(cv_pred, axis=1))
        cv_scores.append({'fold': fold + 1, 'log_loss': cv_ll, 'accuracy': cv_acc})
        print(f"  Fold {fold+1}: LogLoss={cv_ll:.4f}  Accuracy={cv_acc*100:.1f}%")
    avg_ll = np.mean([s['log_loss'] for s in cv_scores])
    avg_acc = np.mean([s['accuracy'] for s in cv_scores])
    print(f"\n  CV Average: LogLoss={avg_ll:.4f}  Accuracy={avg_acc*100:.1f}%")

    # Save training metadata
    meta = {
        'best_params': study.best_params,
        'test_accuracy': float(acc),
        'test_log_loss': float(ll),
        'cv_avg_log_loss': float(avg_ll),
        'cv_avg_accuracy': float(avg_acc),
        'n_features': len(FEATURE_NAMES_TITANIUM),
        'n_train': len(X_train_aug),
        'n_val': len(X_val),
        'n_test': len(X_test),
        'top_features': [{'name': n, 'importance': float(i)} for n, i in feat_imp[:15]],
        'cv_folds': cv_scores,
        'optuna_trials': 50
    }
    meta_path = MODEL_PATH.replace('.json', '_meta.json')
    with open(meta_path, 'w') as f:
        json.dump(meta, f, indent=2)
    print(f"Metadata saved: {meta_path}")


if __name__ == "__main__":
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(line_buffering=True)
    train_model()
