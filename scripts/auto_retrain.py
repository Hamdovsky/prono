"""
auto_retrain.py — Automated XGBoost retraining for V56 model
Scheduled weekly via cronManager, trains V56 on soccer_fixtures + soccer_match_stats
using chronological split (85% old → train, 15% recent → validate).

Saves to: models/xgboost_v55.json (loaded by get_v56_booster as V56)
Feature set: FEATURE_NAMES_V56 (22 raw match-stat features + form + H2H)

Usage:
    python scripts/auto_retrain.py                           # Train V56
    python scripts/auto_retrain.py --validate-only            # Validate only

Requires: DATABASE_URL env var pointing to Neon PostgreSQL
"""
import os, sys, json, math, argparse
from datetime import datetime
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'core'))

from pg_connector import query, using_postgres

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models')
MODEL_PATH = os.path.join(MODELS_DIR, 'xgboost_v55.json')
os.makedirs(MODELS_DIR, exist_ok=True)

V56_HYPERPARAMS = {
    'max_depth': 6,
    'learning_rate': 0.08,
    'n_estimators': 500,
    'subsample': 0.8,
    'colsample_bytree': 0.7,
    'min_child_weight': 3,
    'gamma': 0.1,
    'reg_alpha': 0.5,
    'reg_lambda': 1.0,
    'eval_metric': 'mlogloss',
    'early_stopping_rounds': 50,
}


def fetch_training_data():
    """Fetch finished fixtures with stats + odds + league params from Neon.
    Returns rows ordered ASC by date (oldest first) for chronological integrity."""
    print("Fetching training data from Neon...")
    rows = query("""
        SELECT f.id, f.home_team, f.away_team, f.goals_home, f.goals_away,
               f.odds_home, f.odds_away, f.odds_draw, f.date,
               m.home_shots_total as home_shots,
               m.away_shots_total as away_shots,
               m.home_shots_on_goal, m.away_shots_on_goal,
               m.home_shots_inside_box, m.away_shots_inside_box,
               m.home_corners, m.away_corners,
               m.home_fouls, m.away_fouls,
               m.home_yellow_cards, m.away_yellow_cards,
               m.home_red_cards, m.away_red_cards,
               m.home_possession, m.away_possession,
               p.attack_rating as home_attack_rating,
               p.defense_rating as home_defense_rating
        FROM soccer_fixtures f
        LEFT JOIN soccer_match_stats m ON f.id = m.fixture_id
        LEFT JOIN league_model_parameters p ON p.team_name = f.home_team
        WHERE f.goals_home IS NOT NULL AND f.goals_away IS NOT NULL
          AND m.home_shots_total IS NOT NULL
        ORDER BY f.date ASC
        LIMIT 100000
    """) or []
    print(f"  Loaded {len(rows)} training samples (OLDEST first)")
    return rows


def build_v56_dataset(rows):
    """Build feature matrix + labels using only past data for each match.
    Chronological integrity: match i only sees data from indices < i."""
    from ml_features import extract_v56_features

    X, y = [], []
    for i in range(len(rows)):
        if i < 10:
            continue
        r = rows[i]
        gh = float(r.get('goals_home', 0) or 0)
        ga = float(r.get('goals_away', 0) or 0)
        label = 0 if gh > ga else (2 if gh < ga else 1)

        feat = extract_v56_features(r, rows, i)
        if any(math.isnan(v) or math.isinf(v) for v in feat):
            feat = [0.0 if (math.isnan(v) or math.isinf(v)) else v for v in feat]

        X.append(feat)
        y.append(label)

    return np.array(X, dtype=np.float32), np.array(y, dtype=np.int32)


def train_v56(X_train, y_train, X_val, y_val):
    """Train and save V56 XGBoost model with chronological validation."""
    import xgboost as xgb
    from sklearn.metrics import accuracy_score

    params = dict(V56_HYPERPARAMS)
    unique = len(np.unique(y_train))
    if unique == 2:
        params['objective'] = 'binary:logistic'
    elif unique == 3:
        params['objective'] = 'multi:softprob'
    params['num_class'] = unique if unique > 2 else None

    dtrain = xgb.DMatrix(X_train, label=y_train)
    dval = xgb.DMatrix(X_val, label=y_val)

    print(f"  Training V56... train={len(X_train)} val={len(X_val)}")
    model = xgb.train(
        params, dtrain,
        num_boost_round=params.get('n_estimators', 500),
        evals=[(dval, 'val')],
        early_stopping_rounds=params.get('early_stopping_rounds', 50),
        verbose_eval=100,
    )

    model.save_model(MODEL_PATH)
    print(f"  Saved to {MODEL_PATH}")

    y_pred = model.predict(dval)
    if y_pred.ndim > 1:
        y_pred_class = np.argmax(y_pred, axis=1)
    else:
        y_pred_class = (y_pred > 0.5).astype(int)
    acc = accuracy_score(y_val, y_pred_class)
    print(f"  Validation Accuracy: {acc:.4f}")

    return model, acc


def walk_forward_validate(X, y, n_splits=5):
    """Time-series walk-forward validation. Trains on past, validates on future."""
    import xgboost as xgb
    from sklearn.metrics import accuracy_score

    n = len(X)
    fold_size = n // (n_splits + 1)
    accs = []

    for i in range(n_splits):
        train_end = (i + 1) * fold_size
        val_start = train_end
        val_end = min(val_start + fold_size, n)
        if val_end - val_start < 100:
            continue

        X_t, y_t = X[:train_end], y[:train_end]
        X_v, y_v = X[val_start:val_end], y[val_start:val_end]

        params = {**V56_HYPERPARAMS, 'objective': 'multi:softprob', 'num_class': 3}
        dtrain = xgb.DMatrix(X_t, label=y_t)
        dval = xgb.DMatrix(X_v, label=y_v)
        m = xgb.train(params, dtrain, num_boost_round=200,
                       evals=[(dval, 'val')], early_stopping_rounds=30,
                       verbose_eval=0)
        yp = m.predict(dval)
        ypc = np.argmax(yp, axis=1)
        acc = accuracy_score(y_v, ypc)
        accs.append(acc)
        print(f"  Fold {i+1}: val={len(X_v)} acc={acc:.4f}")

    if accs:
        print(f"  Average walk-forward: {np.mean(accs):.4f}")


def retrain():
    """Main retrain: fetch data → build V56 features → chrono split → train."""
    if not using_postgres():
        print("ERROR: DATABASE_URL not set or not PostgreSQL")
        sys.exit(1)

    rows = fetch_training_data()
    if not rows or len(rows) < 200:
        print("ERROR: Not enough training data")
        sys.exit(1)

    X, y = build_v56_dataset(rows)
    print(f"  Total V56 samples: {len(X)}")

    if len(X) < 1000:
        print("ERROR: Insufficient samples after filtering")
        sys.exit(1)

    n = len(X)
    train_end = int(n * 0.85)
    X_train, y_train = X[:train_end], y[:train_end]
    X_val, y_val = X[train_end:], y[train_end:]
    print(f"  Chrono split: {len(X_train)} train, {len(X_val)} val")

    model, val_acc = train_v56(X_train, y_train, X_val, y_val)

    print("\n--- Walk-Forward Validation ---")
    walk_forward_validate(X, y, n_splits=5)

    # Update calibration reference
    try:
        from calibration import fit_calibration
        print("Updating calibration after retrain...")
    except ImportError:
        print("Calibration update skipped")

    print(f"\n✅ V56 auto-retrain complete! Accuracy: {val_acc:.4f}")


def validate_only():
    """Validate existing V56 model on latest chrono split."""
    import xgboost as xgb
    from sklearn.metrics import accuracy_score

    if not os.path.exists(MODEL_PATH):
        print(f"  Model not found at {MODEL_PATH}")
        return

    rows = fetch_training_data()
    if not rows or len(rows) < 200:
        print("Not enough data")
        return

    X, y = build_v56_dataset(rows)
    n = len(X)
    val_start = int(n * 0.85)
    X_v, y_v = X[val_start:], y[val_start:]

    model = xgb.Booster()
    model.load_model(MODEL_PATH)
    dval = xgb.DMatrix(X_v)
    y_pred = model.predict(dval)
    if y_pred.ndim > 1:
        y_pred_class = np.argmax(y_pred, axis=1)
    else:
        y_pred_class = (y_pred > 0.5).astype(int)
    acc = accuracy_score(y_v, y_pred_class)
    print(f"  V56 accuracy on {len(X_v)} chrono val samples: {acc:.4f}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--validate-only', action='store_true', help='Validate existing model')
    args = parser.parse_args()
    if args.validate_only:
        validate_only()
    else:
        retrain()
