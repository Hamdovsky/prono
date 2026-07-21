import os, sys, math, sqlite3
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import accuracy_score, log_loss
from sklearn.utils.class_weight import compute_sample_weight

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, 'scripts'))

from train_promosport_v553_enriched import (
    EloSystem, _parse_ts, extract_features, FEATURE_NAMES_V553_STYLE,
    TARGET_ENCODE, noise_augment, mixup_augmentation
)

DB_PATH = os.path.join(BASE_DIR, 'data', 'historical_archive.sqlite')
MODEL_PATH = os.path.join(BASE_DIR, 'models', 'stitch_unified_v553.json')


def train():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    print("Computing ELO...")
    rows = conn.execute("""
        SELECT homeTeam, awayTeam, result, archived_at
        FROM promosport_archive WHERE result IS NOT NULL AND result != 'N'
        ORDER BY archived_at ASC
    """).fetchall()
    elo = EloSystem(k=24)
    elo_snapshots = []
    for r in rows:
        elo.update(r[0], r[1], r[2])
        elo_snapshots.append((r[0], r[1], _parse_ts(r[3]), elo.get_rating(r[0]), elo.get_rating(r[1])))

    limit = int(os.environ.get('PROMOSPORT_TRAIN_LIMIT', '8000'))
    df = pd.read_sql_query(f"""
        SELECT * FROM promosport_archive
        WHERE result IS NOT NULL AND result != 'N'
        ORDER BY archived_at ASC LIMIT {limit}
    """, conn)
    conn.close()

    print(f"Building {len(df)} samples with {len(FEATURE_NAMES_V553_STYLE)} features...")
    X, y = [], []
    for idx, row in df.iterrows():
        try:
            feats = extract_features(row, sqlite3.connect(DB_PATH), elo_snapshots)
            X.append([feats.get(k, 0.0) for k in FEATURE_NAMES_V553_STYLE])
            y.append(TARGET_ENCODE.get(row['result'], 1))
        except:
            pass
        if (idx + 1) % 2000 == 0:
            print(f"  {idx + 1}/{len(df)}")

    X = np.array(X, dtype=np.float32)
    y = np.array(y)
    n = len(X)
    print(f"Total: {n}")

    train_n = int(n * 0.80)
    val_n = int(n * 0.90)
    X_train, X_val, X_test = X[:train_n], X[train_n:val_n], X[val_n:]
    y_train, y_val, y_test = y[:train_n], y[train_n:val_n], y[val_n:]

    X_aug, y_aug = noise_augment(X_train, y_train, noise_level=0.06)
    X_aug, y_aug = mixup_augmentation(X_aug, y_aug)
    cw = compute_sample_weight(class_weight='balanced', y=y_aug)

    print(f"Train: {len(X_train)} Aug: {len(X_aug)} Val: {len(X_val)} Test: {len(X_test)}")

    model = xgb.XGBClassifier(
        objective='multi:softprob', num_class=3, eval_metric='mlogloss',
        learning_rate=0.04, max_depth=5, subsample=0.8, colsample_bytree=0.7,
        min_child_weight=3, reg_lambda=1.5, reg_alpha=0.2, gamma=0.5,
        n_estimators=800, early_stopping_rounds=40, random_state=42
    )
    model.fit(X_aug, y_aug, sample_weight=cw, eval_set=[(X_val, y_val)], verbose=False)

    y_pred = np.argmax(model.predict_proba(X_test), axis=1)
    acc = accuracy_score(y_test, y_pred)
    ll = log_loss(y_test, model.predict_proba(X_test))
    print(f"\nTest: {acc*100:.2f}% | LogLoss: {ll:.4f}")

    model.get_booster().save_model(MODEL_PATH)
    print(f"Saved: {MODEL_PATH}")

    try:
        from sklearn.linear_model import LogisticRegression
        cal = LogisticRegression(C=1e6, solver='lbfgs', max_iter=1000)
        try:
            cal = LogisticRegression(C=1e6, solver='lbfgs', multi_class='multinomial', max_iter=1000)
        except TypeError:
            pass
        cal.fit(model.predict_proba(X_val), y_val)
        cal_probs = cal.predict_proba(model.predict_proba(X_test))
        print(f"Calibrated: {accuracy_score(y_test, np.argmax(cal_probs, axis=1))*100:.2f}%")
        import joblib
        joblib.dump(cal, MODEL_PATH.replace('.json', '_platt.pkl'))
    except Exception as e:
        print(f"Calib: {e}")

    return model


if __name__ == "__main__":
    train()
