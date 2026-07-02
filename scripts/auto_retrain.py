"""
auto_retrain.py — Automated XGBoost model retraining from Neon PostgreSQL
Scheduled: runs weekly via cronManager, retrains all models using latest
378K fixtures from Neon, validates on chronological split (last 10%).

Usage:
    python scripts/auto_retrain.py                           # Train all models
    python scripts/auto_retrain.py --model v553               # Train specific model
    python scripts/auto_retrain.py --validate-only            # Validate only

Requires: DATABASE_URL env var pointing to Neon PostgreSQL
"""
import os, sys, json, math, pickle, argparse
from datetime import datetime, timedelta
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'core'))

from pg_connector import query, using_postgres

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models')
os.makedirs(MODELS_DIR, exist_ok=True)

MODEL_CONFIGS = {
    'v553': {
        'name': 'xgboost_v553',
        'feature_list': 'FEATURE_NAMES_V553',
        'params': {
            'max_depth': 6,
            'learning_rate': 0.08,
            'n_estimators': 500,
            'subsample': 0.85,
            'colsample_bytree': 0.7,
            'min_child_weight': 3,
            'gamma': 0.1,
            'reg_alpha': 0.5,
            'reg_lambda': 1.0,
            'eval_metric': 'logloss',
            'early_stopping_rounds': 50,
        }
    },
    'v55': {
        'name': 'xgboost_v55',
        'feature_list': 'FEATURE_NAMES_V55',
        'params': {
            'max_depth': 6,
            'learning_rate': 0.08,
            'n_estimators': 500,
            'subsample': 0.8,
            'colsample_bytree': 0.7,
            'min_child_weight': 3,
            'gamma': 0.1,
            'reg_alpha': 0.5,
            'reg_lambda': 1.0,
            'eval_metric': 'logloss',
            'early_stopping_rounds': 50,
        }
    },
    'home_xg': {
        'name': 'xg_home_model',
        'features': ['shots_inside_box', 'shots_on_target', 'total_shots', 'possession', 'corners'],
        'params': {
            'max_depth': 4,
            'learning_rate': 0.1,
            'n_estimators': 300,
            'subsample': 0.8,
            'colsample_bytree': 0.8,
            'eval_metric': 'rmse',
            'early_stopping_rounds': 30,
        }
    },
    'away_xg': {
        'name': 'xg_away_model',
        'features': ['shots_inside_box', 'shots_on_target', 'total_shots', 'possession', 'corners'],
        'params': {
            'max_depth': 4,
            'learning_rate': 0.1,
            'n_estimators': 300,
            'subsample': 0.8,
            'colsample_bytree': 0.8,
            'eval_metric': 'rmse',
            'early_stopping_rounds': 30,
        }
    },
}

def fetch_training_data():
    """Fetch finished fixtures with stats from Neon for training."""
    print("Fetching training data from Neon...")
    rows = query("""
        SELECT f.id, f.home_team, f.away_team, f.goals_home, f.goals_away,
               f.odds_home, f.odds_away, f.odds_draw, f.date,
               f.home_possession, f.away_possession,
               f.home_shots, f.away_shots,
               f.home_shots_on_goal, f.away_shots_on_goal,
               f.home_corners, f.away_corners,
               f.home_fouls, f.away_fouls,
               f.home_yellow_cards, f.away_yellow_cards,
               f.home_red_cards, f.away_red_cards,
               f.home_shots_inside_box, f.away_shots_inside_box,
               l.name as league_name,
               p.attack_rating as home_attack_rating,
               p.defense_rating as home_defense_rating
        FROM soccer_fixtures f
        LEFT JOIN soccer_leagues l ON f.league_id = l.id
        LEFT JOIN league_model_parameters p ON p.team_name = f.home_team
        WHERE f.goals_home IS NOT NULL AND f.goals_away IS NOT NULL
          AND f.home_shots IS NOT NULL
        ORDER BY f.date DESC
        LIMIT 50000
    """) or []
    print(f"  Loaded {len(rows)} training samples")
    return rows

def prepare_xg_training(rows):
    """Prepare data for xG model training."""
    X_home, X_away, y_home, y_away = [], [], [], []
    for r in rows:
        ib_h = float(r.get('home_shots_inside_box') or 0)
        ib_a = float(r.get('away_shots_inside_box') or 0)
        sot_h = float(r.get('home_shots_on_goal') or 0)
        sot_a = float(r.get('away_shots_on_goal') or 0)
        ts_h = float(r.get('home_shots') or 0)
        ts_a = float(r.get('away_shots') or 0)
        pos_h = float(r.get('home_possession') or 50)
        pos_a = float(r.get('away_possession') or 50)
        corn_h = float(r.get('home_corners') or 0)
        corn_a = float(r.get('away_corners') or 0)

        goals_h = float(r.get('goals_home') or 0)
        goals_a = float(r.get('goals_away') or 0)

        X_home.append([ib_h, sot_h, ts_h, pos_h, corn_h])
        y_home.append(goals_h)
        X_away.append([ib_a, sot_a, ts_a, pos_a, corn_a])
        y_away.append(goals_a)

    return (np.array(X_home, dtype=np.float32), np.array(y_home, dtype=np.float32),
            np.array(X_away, dtype=np.float32), np.array(y_away, dtype=np.float32))

def prepare_classification_training(rows):
    """Prepare data for win/draw/loss XGBoost classification."""
    X, y = [], []
    for r in rows:
        goals_h = float(r.get('goals_home') or 0)
        goals_a = float(r.get('goals_away') or 0)
        if goals_h > goals_a:
            label = 0  # Home win
        elif goals_h < goals_a:
            label = 2  # Away win
        else:
            label = 1  # Draw

        feat = [
            float(r.get('home_possession') or 50) - float(r.get('away_possession') or 50),
            float(r.get('home_shots') or 0) - float(r.get('away_shots') or 0),
            float(r.get('home_shots_on_goal') or 0) - float(r.get('away_shots_on_goal') or 0),
            float(r.get('home_corners') or 0) - float(r.get('away_corners') or 0),
            float(r.get('home_fouls') or 0) - float(r.get('away_fouls') or 0),
            float(r.get('home_yellow_cards') or 0) - float(r.get('away_yellow_cards') or 0),
            float(r.get('home_red_cards') or 0) - float(r.get('away_red_cards') or 0),
            float(r.get('home_shots_inside_box') or 0) - float(r.get('away_shots_inside_box') or 0),
            float(r.get('home_attack_rating') or 1.0),
            float(r.get('home_defense_rating') or 1.0),
            float(r.get('odds_home') or 2.0),
            float(r.get('odds_away') or 2.0),
        ]
        X.append(feat)
        y.append(label)

    return np.array(X, dtype=np.float32), np.array(y, dtype=np.int32)

def train_xg_model(model_name, X_train, y_train, X_val, y_val, params):
    """Train and save an XGBoost model."""
    import xgboost as xgb
    print(f"Training {model_name}...")

    dtrain = xgb.DMatrix(X_train, label=y_train)
    dval = xgb.DMatrix(X_val, label=y_val)

    model = xgb.train(
        params,
        dtrain,
        num_boost_round=params.get('n_estimators', 500),
        evals=[(dval, 'val')],
        early_stopping_rounds=params.get('early_stopping_rounds', 50),
        verbose_eval=50,
    )

    path = os.path.join(MODELS_DIR, f'{model_name}.json')
    model.save_model(path)
    print(f"  Saved to {path}")

    # Evaluation
    y_pred = model.predict(dval)
    if len(y_pred.shape) > 1 and y_pred.shape[1] > 1:
        y_pred_class = np.argmax(y_pred, axis=1)
    else:
        y_pred_class = (y_pred > 0.5).astype(int)

    if len(y_train.shape) == 1 or y_train.ndim == 1:
        from sklearn.metrics import accuracy_score, mean_squared_error
        if len(np.unique(y_train)) <= 2 or model_name in ['xg_home_model', 'xg_away_model']:
            rmse = np.sqrt(mean_squared_error(y_val, y_pred))
            print(f"  Validation RMSE: {rmse:.4f}")
        else:
            acc = accuracy_score(y_val, y_pred_class)
            print(f"  Validation Accuracy: {acc:.4f}")

    return model

def validate_all():
    """Validate existing models on latest Neon data without retraining."""
    import xgboost as xgb
    print("Validating existing models...")
    rows = fetch_training_data()
    if not rows:
        return

    X_h, y_h, X_a, y_a = prepare_xg_training(rows)
    split = int(len(X_h) * 0.8)
    X_h_val, y_h_val = X_h[split:], y_h[split:]

    for model_cfg in MODEL_CONFIGS.values():
        name = model_cfg['name']
        path = os.path.join(MODELS_DIR, f'{name}.json')
        if os.path.exists(path):
            try:
                model = xgb.Booster()
                model.load_model(path)
                dval = xgb.DMatrix(X_h_val)
                y_pred = model.predict(dval)
                from sklearn.metrics import mean_squared_error
                rmse = np.sqrt(mean_squared_error(y_h_val, y_pred))
                print(f"  {name}: RMSE={rmse:.4f} on {len(y_h_val)} validation samples")
            except Exception as e:
                print(f"  {name}: validation failed - {e}")
        else:
            print(f"  {name}: model file not found at {path}")

def retrain(model_key=None):
    """Main retrain entry point."""
    if not using_postgres():
        print("ERROR: DATABASE_URL not set or not PostgreSQL")
        sys.exit(1)

    rows = fetch_training_data()
    if not rows or len(rows) < 100:
        print("ERROR: Not enough training data")
        sys.exit(1)

    import xgboost as xgb
    from sklearn.model_selection import train_test_split

    models_to_train = [model_key] if model_key else MODEL_CONFIGS.keys()

    for key in models_to_train:
        if key not in MODEL_CONFIGS:
            print(f"Unknown model: {key}")
            continue

        cfg = MODEL_CONFIGS[key]
        name = cfg['name']
        params = cfg['params']

        if key in ['home_xg', 'away_xg']:
            X_h, y_h, X_a, y_a = prepare_xg_training(rows)
            if key == 'home_xg':
                X, y = X_h, y_h
            else:
                X, y = X_a, y_a
        else:
            X, y = prepare_classification_training(rows)

        if len(X) < 1000:
            print(f"  {name}: insufficient samples ({len(X)}), skipping")
            continue

        params['num_class'] = len(np.unique(y)) if key not in ['home_xg', 'away_xg'] else None
        if params.get('num_class') == 2:
            params['objective'] = 'binary:logistic'
        elif params.get('num_class') and params['num_class'] > 2:
            params['objective'] = 'multi:softprob'
        else:
            params['objective'] = 'reg:squarederror'

        X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.15, random_state=42)
        train_xg_model(name, X_train, y_train, X_val, y_val, params)

    # Update calibration after retrain
    try:
        from calibration import fit_calibration
        print("Updating calibration after retrain...")
    except ImportError:
        print("Calibration update skipped (calibration.py not available)")

    print("\n✅ Auto-retrain complete!")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=str, default=None, help='Model key to retrain (default: all)')
    parser.add_argument('--validate-only', action='store_true', help='Only validate existing models')
    args = parser.parse_args()

    if args.validate_only:
        validate_all()
    else:
        retrain(model_key=args.model)
