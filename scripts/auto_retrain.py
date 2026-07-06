"""
auto_retrain.py — Automated XGBoost retraining for TITANIUM V3 (with Tunisia Crowdsourcing)
Scheduled weekly via cronManager, trains TITANIUM V3 on soccer_fixtures + soccer_match_stats
using chronological split (85% old → train, 15% recent → validate).

Saves to: models/titanium_v3.json (loaded by get_titanium_booster as TITANIUM)
Feature set: FEATURE_NAMES_TITANIUM (150+ features + Tunisia crowd features)

Usage:
    python scripts/auto_retrain.py                           # Train TITANIUM V3
    python scripts/auto_retrain.py --validate-only            # Validate only

Requires: DATABASE_URL env var pointing to Neon PostgreSQL
"""
import os, sys, json, math, argparse
from datetime import datetime, timezone
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'core'))

# Load .env for local dev (harmless in production — python-dotenv no-op if missing)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from pg_connector import query, using_postgres

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models')
MODEL_PATH = os.path.join(MODELS_DIR, 'titanium_v3.json')
MODEL_METADATA_PATH = os.path.join(MODELS_DIR, 'titanium_metadata.json')
os.makedirs(MODELS_DIR, exist_ok=True)

REGRESSION_THRESHOLD = 0.03  # Reject if accuracy drops more than 3pp

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
        SELECT f.id,
               ht.name AS home_team,
               at.name AS away_team,
               f.goals_home, f.goals_away,
               o.home_win AS odds_home,
               o.draw AS odds_draw,
               o.away_win AS odds_away,
               f.date,
               m.home_shots_total AS home_shots,
               m.away_shots_total AS away_shots,
               m.home_shots_on_goal, m.away_shots_on_goal,
               m.home_shots_inside_box, m.away_shots_inside_box,
               m.home_corners, m.away_corners,
               m.home_fouls, m.away_fouls,
               m.home_yellow_cards, m.away_yellow_cards,
               m.home_red_cards, m.away_red_cards,
                m.home_possession, m.away_possession,
                m.home_xg, m.away_xg,
                hp.attack_rating AS home_attack_rating,
               hp.defense_rating AS home_defense_rating,
               ap.attack_rating AS away_attack_rating,
               ap.defense_rating AS away_defense_rating
        FROM soccer_fixtures f
        LEFT JOIN soccer_teams ht ON ht.id = f.home_team_id
        LEFT JOIN soccer_teams at ON at.id = f.away_team_id
        LEFT JOIN soccer_match_stats m ON f.id = m.fixture_id
        LEFT JOIN (
            SELECT DISTINCT ON (fixture_id) fixture_id, home_win, draw, away_win
            FROM soccer_odds
            ORDER BY fixture_id, CASE bookmaker WHEN 'Pinnacle' THEN 0 WHEN 'Bet365' THEN 1 ELSE 2 END
        ) o ON o.fixture_id = f.id
        LEFT JOIN (
            SELECT DISTINCT ON (team_name) team_name, attack_rating, defense_rating
            FROM league_model_parameters
            WHERE team_name IS NOT NULL AND attack_rating IS NOT NULL
            ORDER BY team_name, num_matches DESC
        ) hp ON hp.team_name = ht.name
        LEFT JOIN (
            SELECT DISTINCT ON (team_name) team_name, attack_rating, defense_rating
            FROM league_model_parameters
            WHERE team_name IS NOT NULL AND attack_rating IS NOT NULL
            ORDER BY team_name, num_matches DESC
        ) ap ON ap.team_name = at.name
        WHERE f.goals_home IS NOT NULL AND f.goals_away IS NOT NULL
          AND m.home_shots_total IS NOT NULL
        ORDER BY f.date ASC
        LIMIT 100000
    """) or []
    print(f"  Loaded {len(rows)} training samples (OLDEST first)")
    return rows


def build_v56_dataset(rows):
    """Build feature matrix + labels using only past data for each match.
    Chronological integrity: match i only sees data from indices < i.
    
    Updated for TITANIUM V3: Uses FEATURE_NAMES_TITANIUM with Tunisia crowd features.
    """
    from ml_features import extract_ml_features, FEATURE_NAMES_TITANIUM

    X, y = [], []
    for i in range(len(rows)):
        if i < 10:
            continue
        r = rows[i]
        gh = float(r.get('goals_home', 0) or 0)
        ga = float(r.get('goals_away', 0) or 0)
        label = 0 if gh > ga else (2 if gh < ga else 1)

        feat = extract_ml_features(r, fetch_history=True, current_match_ts=r.get('startTimestamp'))
        if any(math.isnan(v) or math.isinf(v) for v in feat.values()):
            feat = {k: 0.0 if (v is None or math.isnan(v) or math.isinf(v)) else float(v) for k, v in feat.items()}
        
        # Convert to ordered list based on FEATURE_NAMES_TITANIUM
        ordered_feats = [feat.get(name, 0.0) for name in FEATURE_NAMES_TITANIUM]
        X.append(ordered_feats)
        y.append(label)

    return np.array(X, dtype=np.float32), np.array(y, dtype=np.int32)


def train_v56(X_train, y_train, X_val, y_val):
    """Train and save TITANIUM V3 XGBoost model with chronological validation."""
    import xgboost as xgb
    from sklearn.metrics import accuracy_score

    # Remove meta-params that xgb.train handles as kwargs
    hp = dict(V56_HYPERPARAMS)
    n_estimators = hp.pop('n_estimators', 500)
    early_stopping = hp.pop('early_stopping_rounds', 50)
    params = hp
    unique = len(np.unique(y_train))
    if unique == 2:
        params['objective'] = 'binary:logistic'
    elif unique == 3:
        params['objective'] = 'multi:softprob'
    params['num_class'] = unique if unique > 2 else None

    dtrain = xgb.DMatrix(X_train, label=y_train)
    dval = xgb.DMatrix(X_val, label=y_val)

    print(f"  Training TITANIUM V3... train={len(X_train)} val={len(X_val)}, features={X_train.shape[1]}")
    model = xgb.train(
        params, dtrain,
        num_boost_round=n_estimators,
        evals=[(dval, 'val')],
        early_stopping_rounds=early_stopping,
        verbose_eval=100,
    )

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

        hp = dict(V56_HYPERPARAMS)
        hp.pop('n_estimators', None)
        hp.pop('early_stopping_rounds', None)
        params = {**hp, 'objective': 'multi:softprob', 'num_class': 3}
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
    """Main retrain: fetch data → build TITANIUM V3 features → chrono split → train."""
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

    # --- Regression guard: compare with previous model accuracy ---
    prev_acc = None
    if os.path.exists(MODEL_METADATA_PATH):
        try:
            with open(MODEL_METADATA_PATH) as f:
                meta = json.load(f)
            prev_acc = meta.get('val_accuracy')
            if prev_acc is not None:
                drop = prev_acc - val_acc
                if drop > REGRESSION_THRESHOLD:
                    print(f"\n[WARN] REGRESSION DETECTED: {prev_acc:.4f} -> {val_acc:.4f} (drop={drop:.4f})")
                    print(f"   Reverting to previous model (threshold={REGRESSION_THRESHOLD})")
                    if os.path.exists(MODEL_PATH + '.bak'):
                        import shutil
                        shutil.copy2(MODEL_PATH + '.bak', MODEL_PATH)
                        print(f"   Restored {MODEL_PATH} from backup")
                    print("\n[ABORT] V56 auto-retrain ABORTED due to regression")
                    sys.exit(1)
                else:
                    print(f"   Previous accuracy: {prev_acc:.4f} -> current: {val_acc:.4f} (drop={drop:.4f}) OK")
        except Exception as e:
            print(f"   Could not read metadata: {e}")

    # Backup previous model before overwriting
    if os.path.exists(MODEL_PATH):
        import shutil
        shutil.copy2(MODEL_PATH, MODEL_PATH + '.bak')

    model.save_model(MODEL_PATH)
    print(f"  Saved to {MODEL_PATH}")

    # Save accuracy metadata
    meta = {
        'val_accuracy': round(float(val_acc), 4),
        'train_samples': len(X_train),
        'val_samples': len(X_val),
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'prev_accuracy': prev_acc,
    }
    with open(MODEL_METADATA_PATH, 'w') as f:
        json.dump(meta, f, indent=2)

    print("\n--- Walk-Forward Validation ---")
    walk_forward_validate(X, y, n_splits=5)

    # Update calibration with validation predictions
    try:
        from calibration import fit_calibration
        import xgboost as xgb
        print("\nUpdating calibration after retrain...")
        y_pred_proba = model.predict(xgb.DMatrix(X_val))
        if y_pred_proba.ndim == 1:
            # Binary case: convert to 3-class probabilities
            home_probs = y_pred_proba.tolist()
            draw_probs = [0.0] * len(y_pred_proba)
            away_probs = [1.0 - p for p in y_pred_proba]
        elif y_pred_proba.shape[1] == 3:
            home_probs = y_pred_proba[:, 0].tolist()
            draw_probs = y_pred_proba[:, 1].tolist()
            away_probs = y_pred_proba[:, 2].tolist()
        else:
            raise ValueError(f"Unexpected prediction shape: {y_pred_proba.shape}")

        outcome_map = {0: 'H', 1: 'D', 2: 'A'}
        outcomes = [outcome_map[int(y)] for y in y_val]
        fit_calibration(home_probs, draw_probs, away_probs, outcomes)
    except Exception as e:
        print(f"  Calibration update skipped: {e}")

    print(f"\n[OK] V56 auto-retrain complete! Accuracy: {val_acc:.4f}")


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
