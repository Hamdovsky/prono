import sqlite3
import pandas as pd
import numpy as np
import os
import sys
import optuna
from sklearn.metrics import accuracy_score, log_loss, classification_report
from collections import defaultdict
from datetime import datetime

sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'core'))

try:
    import xgboost as xgb
except ImportError as e:
    print(f"Import error: {e}")
    sys.exit(1)

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'historical_archive.sqlite')
MODEL_PATH = os.path.join(os.path.dirname(__file__), '..', 'models', 'promosport_xgb.json')
os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)

FEATURE_NAMES = [
    # Historical win/draw/loss rates
    'home_win_rate_5', 'home_draw_rate_5', 'home_loss_rate_5',
    'away_win_rate_5', 'away_draw_rate_5', 'away_loss_rate_5',
    'home_win_rate_10', 'home_draw_rate_10', 'home_loss_rate_10',
    'away_win_rate_10', 'away_draw_rate_10', 'away_loss_rate_10',
    'home_win_rate_all', 'home_draw_rate_all', 'home_loss_rate_all',
    'away_win_rate_all', 'away_draw_rate_all', 'away_loss_rate_all',

    # Public vote features (crowd wisdom)
    'vote_home', 'vote_draw', 'vote_away',
    'vote_home_norm', 'vote_draw_norm', 'vote_away_norm',
    'vote_advantage_home', 'vote_advantage_away',

    # Head-to-head features
    'h2h_home_wins', 'h2h_draws', 'h2h_away_wins', 'h2h_matches',

    # Team quality differentials
    'home_pts_per_match_10', 'away_pts_per_match_10',
    'home_pts_per_match_all', 'away_pts_per_match_all',
    'pts_diff_10', 'pts_diff_all',

    # Goal-based features (when available)
    'home_avg_scored_5', 'home_avg_conceded_5',
    'away_avg_scored_5', 'away_avg_conceded_5',
    'home_avg_scored_10', 'home_avg_conceded_10',
    'away_avg_scored_10', 'away_avg_conceded_10',

    # Form features
    'home_form_score', 'away_form_score',
    'home_last_result', 'away_last_result',

    # Match importance / recency
    'home_matches_in_period', 'away_matches_in_period',
    'total_concours_for_pair',

    # Differential features
    'form_diff', 'win_rate_diff_all', 'avg_scored_diff_10', 'avg_conceded_diff_10',

    # Interaction features
    'vote_x_home_form', 'vote_x_pts_diff', 'home_vote_x_winrate'

    # Total: ~48 features
]


def compute_team_stats(conn, team_name, before_date=None, limit_matches=None):
    """Compute historical stats for a team from promosport_archive."""
    date_filter = ''
    if before_date:
        date_filter = ' AND archived_at < ?'

    limit_filter = ''
    if limit_matches:
        limit_filter = f' ORDER BY archived_at DESC LIMIT {limit_matches}'

    query = f"""
        SELECT result, score_home, score_away
        FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?)
          AND result IS NOT NULL AND result != 'N'
          {date_filter}
        {limit_filter}
    """
    params = [team_name, team_name]
    if before_date:
        params.append(before_date)

    rows = conn.execute(query, params).fetchall()

    if not rows:
        return None

    total = len(rows)
    wins = draws = losses = 0
    goals_for = goals_against = 0
    pts_total = 0

    for r in rows:
        result = r[0]
        if result == '1':
            wins += 1
            pts_total += 3
        elif result == 'X':
            draws += 1
            pts_total += 1
        elif result == '2':
            losses += 1

    # Re-read to get scores where available
    score_rows = conn.execute(f"""
        SELECT result, score_home, score_away, homeTeam
        FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?)
          AND result IS NOT NULL AND result != 'N'
          AND score_home IS NOT NULL
          {date_filter}
        {limit_filter}
    """, params).fetchall()

    gf = ga = 0
    for r in score_rows:
        is_home = (r[3] == team_name)
        if is_home and r[1] is not None:
            gf += int(r[1])
            ga += int(r[2]) if r[2] else 0
        elif r[2] is not None:
            gf += int(r[2])
            ga += int(r[1]) if r[1] else 0

    return {
        'matches': total,
        'wins': wins,
        'draws': draws,
        'losses': losses,
        'pts_total': pts_total,
        'win_rate': wins / total if total > 0 else 0,
        'draw_rate': draws / total if total > 0 else 0,
        'loss_rate': losses / total if total > 0 else 0,
        'pts_per_match': pts_total / total if total > 0 else 0,
        'avg_scored': gf / len(score_rows) if score_rows else 0.5,
        'avg_conceded': ga / len(score_rows) if score_rows else 0.5,
        'gf': gf,
        'ga': ga
    }


def get_h2h_stats(conn, home_team, away_team, before_date=None):
    """Head-to-head stats from archive_matches."""
    date_filter = ''
    params = [home_team, away_team, home_team, away_team]
    if before_date:
        date_filter = ' AND archived_at < ?'
        params.append(before_date)

    rows = conn.execute(f"""
        SELECT result, score_home, score_away
        FROM promosport_archive
        WHERE ((homeTeam = ? AND awayTeam = ?) OR (homeTeam = ? AND awayTeam = ?))
          AND result IS NOT NULL AND result != 'N'
          {date_filter}
        ORDER BY archived_at DESC LIMIT 10
    """, params).fetchall()

    h_wins = d = a_wins = 0
    for r in rows:
        is_home_at_home = (r[0] == '1')
        if is_home_at_home:
            h_wins += 1
        elif r[0] == 'X':
            d += 1
        else:
            a_wins += 1

    return {
        'home_wins': h_wins,
        'draws': d,
        'away_wins': a_wins,
        'total': len(rows)
    }


def get_form_last_5(conn, team_name, before_date=None):
    """Recent form encoded as: win=3, draw=1, loss=0."""
    date_filter = ''
    params = [team_name, team_name]
    if before_date:
        date_filter = ' AND archived_at < ?'
        params.append(before_date)

    rows = conn.execute(f"""
        SELECT result, homeTeam
        FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?)
          AND result IS NOT NULL AND result != 'N'
          {date_filter}
        ORDER BY archived_at DESC LIMIT 5
    """, params).fetchall()

    score = 0
    last_result = 0
    for i, r in enumerate(rows):
        is_home = (r[1] == team_name)
        res = r[0]
        if res == '1':
            pts = 3 if is_home else 0
        elif res == '2':
            pts = 0 if is_home else 3
        else:
            pts = 1
        score += (pts * (1.0 / (i + 1)))
        if i == 0:
            last_result = pts

    return {'form_score': score, 'last_result': last_result}


def get_team_concours_count(conn, team_name, before_date=None):
    """Count how many concours this team has appeared in."""
    date_filter = ''
    params = [team_name, team_name]
    if before_date:
        date_filter = ' AND archived_at < ?'
        params.append(before_date)

    row = conn.execute(f"""
        SELECT COUNT(DISTINCT concours) FROM promosport_archive
        WHERE (homeTeam = ? OR awayTeam = ?)
          AND result IS NOT NULL AND result != 'N'
          {date_filter}
    """, params).fetchone()
    return row[0]


def extract_features(row, conn, team_cache):
    """Extract feature vector for a single match row."""
    home = row['homeTeam']
    away = row['awayTeam']
    vote_h = row['vote_home'] if pd.notna(row.get('vote_home')) else 50
    vote_d = row['vote_draw'] if pd.notna(row.get('vote_draw')) else 33
    vote_a = row['vote_away'] if pd.notna(row.get('vote_away')) else 17
    archived_at = row.get('archived_at', None)

    f = {}

    # Public vote features
    total_votes = vote_h + vote_d + vote_a
    f['vote_home'] = vote_h
    f['vote_draw'] = vote_d
    f['vote_away'] = vote_a
    f['vote_home_norm'] = vote_h / total_votes if total_votes > 0 else 0.5
    f['vote_draw_norm'] = vote_d / total_votes if total_votes > 0 else 0.33
    f['vote_away_norm'] = vote_a / total_votes if total_votes > 0 else 0.17
    f['vote_advantage_home'] = vote_h - vote_a
    f['vote_advantage_away'] = vote_a - vote_h

    # Team historical stats at multiple windows
    for window, suffix in [(5, '5'), (10, '10'), (None, 'all')]:
        hs = compute_team_stats(conn, home, archived_at, window)
        aws = compute_team_stats(conn, away, archived_at, window)

        if hs:
            f[f'home_win_rate_{suffix}'] = hs['win_rate']
            f[f'home_draw_rate_{suffix}'] = hs['draw_rate']
            f[f'home_loss_rate_{suffix}'] = hs['loss_rate']
            f[f'home_pts_per_match_{suffix}'] = hs['pts_per_match']
            f[f'home_avg_scored_{suffix}'] = hs['avg_scored']
            f[f'home_avg_conceded_{suffix}'] = hs['avg_conceded']
        else:
            for k in [f'home_win_rate_{suffix}', f'home_draw_rate_{suffix}', f'home_loss_rate_{suffix}',
                      f'home_pts_per_match_{suffix}', f'home_avg_scored_{suffix}', f'home_avg_conceded_{suffix}']:
                f[k] = 0.33

        if aws:
            f[f'away_win_rate_{suffix}'] = aws['win_rate']
            f[f'away_draw_rate_{suffix}'] = aws['draw_rate']
            f[f'away_loss_rate_{suffix}'] = aws['loss_rate']
            f[f'away_pts_per_match_{suffix}'] = aws['pts_per_match']
            f[f'away_avg_scored_{suffix}'] = aws['avg_scored']
            f[f'away_avg_conceded_{suffix}'] = aws['avg_conceded']
        else:
            for k in [f'away_win_rate_{suffix}', f'away_draw_rate_{suffix}', f'away_loss_rate_{suffix}',
                      f'away_pts_per_match_{suffix}', f'away_avg_scored_{suffix}', f'away_avg_conceded_{suffix}']:
                f[k] = 0.33

    # Point differentials
    f['pts_diff_10'] = f.get('home_pts_per_match_10', 0.33) - f.get('away_pts_per_match_10', 0.33)
    f['pts_diff_all'] = f.get('home_pts_per_match_all', 0.33) - f.get('away_pts_per_match_all', 0.33)

    # H2H
    h2h = get_h2h_stats(conn, home, away, archived_at)
    f['h2h_home_wins'] = h2h['home_wins']
    f['h2h_draws'] = h2h['draws']
    f['h2h_away_wins'] = h2h['away_wins']
    f['h2h_matches'] = h2h['total']

    # Form
    home_form = get_form_last_5(conn, home, archived_at)
    away_form = get_form_last_5(conn, away, archived_at)
    f['home_form_score'] = home_form['form_score']
    f['away_form_score'] = away_form['form_score']
    f['home_last_result'] = home_form['last_result']
    f['away_last_result'] = away_form['last_result']

    # Match volume
    f['home_matches_in_period'] = get_team_concours_count(conn, home, archived_at)
    f['away_matches_in_period'] = get_team_concours_count(conn, away, archived_at)
    f['total_concours_for_pair'] = f['home_matches_in_period'] + f['away_matches_in_period']

    # Differential features
    f['form_diff'] = f.get('home_form_score', 5) - f.get('away_form_score', 5)
    f['win_rate_diff_all'] = f.get('home_win_rate_all', 0.33) - f.get('away_win_rate_all', 0.33)
    f['avg_scored_diff_10'] = f.get('home_avg_scored_10', 0.5) - f.get('away_avg_scored_10', 0.5)
    f['avg_conceded_diff_10'] = f.get('home_avg_conceded_10', 0.5) - f.get('away_avg_conceded_10', 0.5)

    # Interaction features
    f['vote_x_home_form'] = f['vote_home'] * f['home_form_score']
    f['vote_x_pts_diff'] = f['vote_home'] * f['pts_diff_10']
    f['home_vote_x_winrate'] = f['vote_home_norm'] * f['home_win_rate_10']

    return f


def load_training_data():
    if not os.path.exists(DB_PATH):
        print(f"Database not found at {DB_PATH}")
        return None

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    df = pd.read_sql_query("""
        SELECT * FROM promosport_archive
        WHERE result IS NOT NULL AND result != 'N'
        ORDER BY archived_at ASC
    """, conn)

    conn.close()
    return df


def encode_target(row):
    result = row['result']
    if result == '1':
        return 2  # Home win
    elif result == '2':
        return 0  # Away win
    else:
        return 1  # Draw


def build_dataset(df):
    print(f"Building feature matrix from {len(df)} matches...")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    X_list = []
    y_list = []
    errors = 0

    for idx, row in df.iterrows():
        try:
            features = extract_features(row, conn, {})
            X_list.append([features.get(k, 0.0) for k in FEATURE_NAMES])
            y_list.append(encode_target(row))
        except Exception as e:
            errors += 1
            if errors <= 3:
                print(f"  Error row {idx}: {e}")

        if (idx + 1) % 200 == 0:
            print(f"  Progress: {idx + 1}/{len(df)}")

    conn.close()
    print(f"Done: {len(X_list)} samples, {errors} errors")
    return np.array(X_list, dtype=np.float32), np.array(y_list)


def noise_augment(X, y, noise_level=0.05, rng=None):
    if rng is None:
        rng = np.random.default_rng(42)
    noise = rng.normal(0, noise_level, X.shape)
    mask = np.abs(X) > 0.01
    X_aug = X.copy()
    X_aug[mask] = X_aug[mask] * (1.0 + noise[mask])
    X_aug = np.clip(X_aug, -5, 5)
    return np.vstack([X, X_aug]), np.concatenate([y, y])


def train_model():
    print("=" * 60)
    print("PROMOSPORT XGBoOST TRAINING")
    print("=" * 60)

    df = load_training_data()
    if df is None or len(df) < 50:
        print(f"Not enough data: {len(df) if df is not None else 0}")
        return

    print(f"Total matches with results: {len(df)}")

    X, y = build_dataset(df)
    n = len(X)
    if n < 50:
        print(f"Not enough samples after processing: {n}")
        return

    # Time-based split
    train_end = int(n * 0.70)
    val_end = int(n * 0.85)

    X_train, y_train = X[:train_end], y[:train_end]
    X_val, y_val = X[train_end:val_end], y[train_end:val_end]
    X_test, y_test = X[val_end:], y[val_end:]

    print(f"\nSplit: train={len(X_train)} val={len(X_val)} test={len(X_test)}")

    # Augment
    X_train_aug, y_train_aug = noise_augment(X_train, y_train, noise_level=0.08)
    print(f"Augmented: {len(X_train)} -> {len(X_train_aug)}")

    # Class weights
    classes, counts = np.unique(y_train_aug, return_counts=True)
    weights = {int(c): max(counts) / cnt for c, cnt in zip(classes, counts)}
    sample_weights = np.array([weights[int(y)] for y in y_train_aug])
    print(f"Class distribution: {dict(zip(classes, counts))}")
    print(f"Class weights: {weights}")

    print("\nOptimizing with Optuna...")

    def objective(trial):
        params = {
            'objective': 'multi:softprob',
            'num_class': 3,
            'eval_metric': 'mlogloss',
            'learning_rate': trial.suggest_float('lr', 0.01, 0.15, log=True),
            'max_depth': trial.suggest_int('max_depth', 3, 8),
            'subsample': trial.suggest_float('subsample', 0.6, 0.95),
            'colsample_bytree': trial.suggest_float('colsample_bytree', 0.5, 0.9),
            'min_child_weight': trial.suggest_int('min_child_weight', 1, 5),
            'reg_alpha': trial.suggest_float('alpha', 0.0, 1.0),
            'reg_lambda': trial.suggest_float('lambda', 0.0, 2.0),
            'n_estimators': trial.suggest_int('n_est', 200, 600),
            'random_state': 42,
            'early_stopping_rounds': 20
        }
        model = xgb.XGBClassifier(**params)
        model.fit(X_train_aug, y_train_aug, sample_weight=sample_weights,
                  eval_set=[(X_val, y_val)], verbose=False)
        return log_loss(y_val, model.predict_proba(X_val))

    study = optuna.create_study(direction='minimize', sampler=optuna.samplers.TPESampler(seed=42))
    study.optimize(objective, n_trials=20, show_progress_bar=True)

    best_params = study.best_params
    best_params.update({
        'objective': 'multi:softprob',
        'num_class': 3,
        'eval_metric': 'mlogloss',
        'random_state': 42
    })
    print(f"\nBest params: {best_params}")

    model = xgb.XGBClassifier(**best_params)
    model.fit(X_train_aug, y_train_aug, sample_weight=sample_weights,
              eval_set=[(X_val, y_val)], verbose=False)

    y_pred = np.argmax(model.predict_proba(X_test), axis=1)
    acc = accuracy_score(y_test, y_pred)
    ll = log_loss(y_test, model.predict_proba(X_test))

    print(f"\n{'=' * 60}")
    print(f"TEST SET RESULTS")
    print(f"{'=' * 60}")
    print(f"Accuracy: {acc * 100:.2f}% | Log Loss: {ll:.4f}")
    print(f"Test size: {len(y_test)} matches")
    print(f"\nClassification Report:")
    print(classification_report(y_test, y_pred, target_names=['Away', 'Draw', 'Home']))

    # Confusion matrix
    from sklearn.metrics import confusion_matrix
    cm = confusion_matrix(y_test, y_pred)
    print(f"Confusion Matrix:")
    print(f"           Pred Away  Pred Draw  Pred Home")
    print(f"Actual Away  {cm[0, 0]:5d}     {cm[0, 1]:5d}     {cm[0, 2]:5d}")
    print(f"Actual Draw  {cm[1, 0]:5d}     {cm[1, 1]:5d}     {cm[1, 2]:5d}")
    print(f"Actual Home  {cm[2, 0]:5d}     {cm[2, 1]:5d}     {cm[2, 2]:5d}")

    # Feature importance
    importance = model.get_booster().get_score(importance_type='gain')
    sorted_imp = sorted(importance.items(), key=lambda x: x[1], reverse=True)
    print(f"\nTop 20 Feature Importances (by gain):")
    for i, (feat, imp) in enumerate(sorted_imp[:20]):
        print(f"  {i + 1:2d}. {feat}: {imp:.3f}")

    # Save model with feature names
    model.get_booster().set_param('feature_names', ','.join(FEATURE_NAMES))
    model.get_booster().save_model(MODEL_PATH)
    print(f"\nModel saved: {MODEL_PATH}")

    # Platt calibration — sklearn <1.0 workaround
    try:
        from sklearn.calibration import CalibratedClassifierCV, _SigmoidCalibration
        from sklearn.linear_model import LogisticRegression
        # Manual Platt scaling: train logistic regression on val set probabilities
        val_probs = model.predict_proba(X_val)
        cal_model = LogisticRegression(C=1e6, solver='lbfgs', multi_class='multinomial', max_iter=1000)
        cal_model.fit(val_probs, y_val)
        cal_probs = cal_model.predict_proba(model.predict_proba(X_test))
        cal_acc = accuracy_score(y_test, np.argmax(cal_probs, axis=1))
        cal_ll = log_loss(y_test, cal_probs)
        print(f"Calibrated: acc={cal_acc*100:.2f}% log_loss={cal_ll:.4f}")
        import joblib
        calibrator_path = MODEL_PATH.replace('.json', '_platt.pkl')
        joblib.dump(cal_model, calibrator_path)
        print(f"Platt calibrator saved: {calibrator_path}")
    except Exception as e:
        print(f"Calibration skipped: {e}")

    # Verify model loads
    import json
    booster = xgb.Booster()
    booster.load_model(MODEL_PATH)
    dtest = xgb.DMatrix(X_test, feature_names=FEATURE_NAMES)
    y_pred_proba = booster.predict(dtest)
    y_pred = np.argmax(y_pred_proba, axis=1)
    test_acc = accuracy_score(y_test, y_pred)
    print(f"Verification load OK - test acc: {test_acc * 100:.2f}%")

    # ─── Rollback protection ───
    if os.path.exists(BACKUP_PATH):
        old_acc = None
        try:
            old_booster = xgb.Booster()
            old_booster.load_model(BACKUP_PATH)
            old_probs = old_booster.predict(dtest)
            old_pred = np.argmax(old_probs, axis=1)
            old_acc = accuracy_score(y_test, old_pred)
            old_ll = log_loss(y_test, old_probs)
            print(f"Old model: acc={old_acc*100:.2f}% log_loss={old_ll:.4f}")
        except Exception as e:
            print(f"Could not evaluate old model: {e}")

        if old_acc is not None and old_acc >= test_acc:
            import shutil
            shutil.copy(BACKUP_PATH, MODEL_PATH)
            print(f"Rollback: old acc={old_acc*100:.2f}% >= new acc={test_acc*100:.2f}%")
        else:
            print(f"New model accepted: {test_acc*100:.2f}% vs old {old_acc*100:.2f}%")
    else:
        print("No backup found, keeping new model")

    return model


BACKUP_PATH = os.path.join(os.path.dirname(__file__), '..', 'models', 'promosport_xgb.backup.json')
MODEL_PATH = os.path.join(os.path.dirname(__file__), '..', 'models', 'promosport_xgb.json')


def backup_model():
    import shutil
    if os.path.exists(MODEL_PATH):
        shutil.copy(MODEL_PATH, BACKUP_PATH)
        print(f"Backup saved: {MODEL_PATH} -> {BACKUP_PATH}")
        return True
    print("No existing model to backup")
    return False


if __name__ == "__main__":
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(line_buffering=True)
    backup_model()
    train_model()
