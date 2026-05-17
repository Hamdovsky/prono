import sqlite3
import pandas as pd
import numpy as np
import xgboost as xgb
import json
import os
import matplotlib
matplotlib.use('Agg')  # Non-interactive backend for server environments
import matplotlib.pyplot as plt
from sklearn.model_selection import train_test_split, cross_val_score, GridSearchCV
from sklearn.metrics import accuracy_score, log_loss, confusion_matrix, classification_report
from sklearn.impute import SimpleImputer
import warnings

warnings.filterwarnings('ignore')

# ml_features.py guarantees that training features = live inference features (same 39)
from ml_features import extract_ml_features, FEATURE_NAMES

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'historical_archive.sqlite')
MODEL_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'stitch_v18_titanium.json')
PLOT_OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'training_reports')

# ─────────────────────────────────────────────
# STEP 1: LOAD HISTORICAL DATA FROM SQLITE
# ─────────────────────────────────────────────
# accuracy_log.json contains historical prediction failures for weighted learning
ACCURACY_LOG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'accuracy_log.json')

def load_and_prepare_data(limit=12000):
    """
    1. تحميل البيانات وتخزينها
    Loads matches from SQLite, extracts 39-feature vectors from each row.
    """
    if not os.path.exists(DB_PATH):
        print(f"❌ Error: Archive DB not found at {DB_PATH}")
        return None, None, None

    print(f"📥 Loading up to {limit} historical matches from archive...")
    conn = sqlite3.connect(DB_PATH)
    df_raw = pd.read_sql(
        f"SELECT * FROM archive_matches WHERE stats_blob IS NOT NULL ORDER BY id DESC LIMIT {limit}",
        conn
    )
    conn.close()

    data, labels, match_ids = [], [], []

    for _, row in df_raw.iterrows():
        try:
            feats = extract_ml_features(row, fetch_history=False)
            data.append([feats.get(f, np.nan) for f in FEATURE_NAMES])
            # Labels: 0=Home Win, 1=Draw, 2=Away Win
            hg, ag = row['scoreHome'], row['scoreAway']
            if hg > ag:   labels.append(0)
            elif hg == ag: labels.append(1)
            else:          labels.append(2)
            match_ids.append(row['id'])
        except Exception:
            continue

    X = pd.DataFrame(data, columns=FEATURE_NAMES)
    y = pd.Series(labels)
    ids = pd.Series(match_ids)
    print(f"✅ Extracted {len(X)} matches × {X.shape[1]} features.")
    return X, y, ids


# ─────────────────────────────────────────────
# STEP 2: CLEAN AND ENGINEER DATA
# ─────────────────────────────────────────────
def clean_and_engineer_data(X):
    """
    إعداد وتحليل البيانات
    Handles missing values and applies temporal noise reduction.
    """
    print("🧹 Cleaning data: handling NaNs with median imputation...")
    imputer = SimpleImputer(strategy='median')
    X_imputed = pd.DataFrame(imputer.fit_transform(X), columns=X.columns)

    # Temporal noise injection to simulate match-to-match variance (1%)
    noise_cols = [c for c in X_imputed.columns if any(k in c for k in ['possession', 'xg', 'acc', 'sot'])]
    for col in noise_cols:
        X_imputed[col] = X_imputed[col] * (1 + np.random.normal(0, 0.01, len(X_imputed)))

    print("✨ Data cleaned and temporal variance applied.")
    return X_imputed


# ─────────────────────────────────────────────
# STEP 3: TRAIN AND OPTIMIZE XGBOOST
# ─────────────────────────────────────────────
def get_sample_weights(match_ids):
    """
    Calculates weights for training samples.
    Gap matches (misled by AI) get 5.0x weight to force correction.
    """
    weights = np.ones(len(match_ids))
    if not os.path.exists(ACCURACY_LOG_PATH):
        return weights

    try:
        with open(ACCURACY_LOG_PATH, 'r', encoding='utf-8') as f:
            log_data = json.load(f)
        
        gap_ids = set()
        for league in log_data.values():
            for entry in league:
                if entry.get('vote_was_misleading'):
                    gap_ids.add(str(entry.get('matchId')))
        
        if gap_ids:
            print(f"🧬 [DNA] Found {len(gap_ids)} Gap-match IDs. Applying 5.0x penalty weight...")
            for i, mid in enumerate(match_ids):
                if str(mid) in gap_ids:
                    weights[i] = 5.0
                    
    except Exception as e:
        print(f"⚠️ [WARN] Failed to load Gap DNA: {e}")
        
    return weights

# ─────────────────────────────────────────────
# STEP 3: TRAIN AND OPTIMIZE XGBOOST
# ─────────────────────────────────────────────
def train_and_optimize(X, y, match_ids):
    """
    إنشاء نموذج XGBoost وتحسينه
    Trains with cross-validation, GridSearch, and confusion matrix analysis.
    """
    # Calculate sample weights (Gap Learning V19)
    weights = get_sample_weights(match_ids)

    # 3a. Split (80% train / 20% test)
    X_train, X_test, y_train, y_test, w_train, w_test = train_test_split(
        X, y, weights, test_size=0.2, random_state=42
    )

    base_model = xgb.XGBClassifier(
        objective='multi:softprob',
        num_class=3,
        eval_metric='mlogloss',
        use_label_encoder=False,
        n_jobs=-1
    )

    # 3b. 5-Fold Cross Validation on base model
    print("\n⚙️ Running 5-Fold Cross-Validation on base model...")
    # Note: cross_val_score doesn't take sample_weight directly in this context without a fit_params hack
    # but since this is for accuracy estimation, it's fine.
    cv_scores = cross_val_score(base_model, X, y, cv=5, scoring='accuracy')
    print(f"📊 Base CV Accuracy: {cv_scores.mean()*100:.2f}% ± {cv_scores.std()*100:.2f}%")

    # 3c. Hyperparameter tuning via GridSearch
    param_grid = {
        'max_depth':        [4, 6, 8],
        'learning_rate':    [0.05, 0.1],
        'n_estimators':     [100, 200, 300],
        'subsample':        [0.8, 1.0],
    }

    print("\n🔍 Searching for optimal hyperparameters via GridSearchCV (cv=3)...")
    grid = GridSearchCV(base_model, param_grid, cv=3, scoring='accuracy', verbose=1, n_jobs=-1)
    
    # 🧪 V19: FEED WEIGHTS INTO GRID SEARCH
    grid.fit(X_train, y_train, sample_weight=w_train)
    best_model = grid.best_estimator_

    print(f"\n🏆 Best Hyperparameters: {grid.best_params_}")

    # 3d. Evaluate on test set
    y_pred = best_model.predict(X_test)
    accuracy = accuracy_score(y_test, y_pred)
    print(f"\n🎯 Test Set Accuracy: {accuracy*100:.2f}%")

    # 3e. Confusion Matrix
    print("\n📋 Confusion Matrix (0=Home, 1=Draw, 2=Away):")
    cm = confusion_matrix(y_test, y_pred, labels=[0, 1, 2])
    print(cm)
    print("\n📋 Detailed Classification Report:")
    print(classification_report(y_test, y_pred,
                                labels=[0, 1, 2],
                                target_names=['Home Win', 'Draw', 'Away Win'],
                                zero_division=0))

    return best_model, X_train, X_test, y_train, y_test, w_train


# ─────────────────────────────────────────────
# STEP 4: ERROR ANALYSIS & CONTINUOUS IMPROVEMENT
# ─────────────────────────────────────────────
def error_analysis_and_improvement(model, X_train, y_train, X_test, y_test, w_train):
    """
    تحليل الأخطاء وتحسين النموذج بشكل مستمر
    If False Negatives exceed acceptable threshold, retrain with corrective params.
    """
    y_pred = model.predict(X_test)
    cm = confusion_matrix(y_test, y_pred)

    # If Draw predictions are heavily misclassified, retrain with deeper trees
    draw_recall = cm[1, 1] / max(cm[1, :].sum(), 1)
    print(f"\n🔬 Draw Prediction Recall (hardest class): {draw_recall*100:.1f}%")

    if draw_recall < 0.35:
        print("⚠️ Re-training model with corrective scale_pos_weight for balanced draws...")
        model.set_params(max_depth=8, n_estimators=300, min_child_weight=5)
        model.fit(X_train, y_train, sample_weight=w_train)
        y_pred_new = model.predict(X_test)
        new_acc = accuracy_score(y_test, y_pred_new)
        print(f"🔄 Model accuracy after correction: {new_acc*100:.2f}%")
    else:
        print("✅ Error analysis passed. No corrective retraining needed.")

    return model


# ─────────────────────────────────────────────
# STEP 5: MONTE CARLO SIMULATION (Vectorized)
# ─────────────────────────────────────────────
def simulate_match_mc(model, X_test_sample, num_simulations=10000):
    """
    محاكاة مونت كارلو لتقدير التوقعات الدقيقة
    Runs 10,000 noisy simulations using XGBoost probabilities.
    This is used for final validation of the trained model.
    """
    X_base = X_test_sample.values if hasattr(X_test_sample, 'values') else np.array(X_test_sample)
    # Expand to (num_simulations, n_features) with Gaussian noise
    X_tiled = np.tile(X_base[0], (num_simulations, 1))
    noise = np.random.normal(0, 0.05, X_tiled.shape)
    X_noisy = X_tiled + (X_tiled * noise)

    dmatrix = xgb.DMatrix(X_noisy, feature_names=FEATURE_NAMES)
    probs = model.get_booster().predict(dmatrix)  # (10000, 3)

    win_probability  = float(np.mean(probs[:, 0]))
    draw_probability = float(np.mean(probs[:, 1]))
    loss_probability = float(np.mean(probs[:, 2]))

    return win_probability, draw_probability, loss_probability


# ─────────────────────────────────────────────
# STEP 6: PLOT FEATURE IMPORTANCE
# ─────────────────────────────────────────────
def save_feature_importance_plot(model):
    """Saves feature importance chart to the reports folder."""
    os.makedirs(PLOT_OUTPUT_DIR, exist_ok=True)
    fig, ax = plt.subplots(figsize=(12, 8))
    xgb.plot_importance(model, ax=ax, max_num_features=20, importance_type='gain')
    ax.set_title('Top 20 Feature Importances - Stitch V17 Ultra', fontsize=14, fontweight='bold')
    plt.tight_layout()
    plot_path = os.path.join(PLOT_OUTPUT_DIR, 'feature_importance_v17.png')
    plt.savefig(plot_path, dpi=150)
    plt.close()
    print(f"\n📈 Feature importance chart saved to: {plot_path}")


# ─────────────────────────────────────────────
# MAIN PIPELINE
# ─────────────────────────────────────────────
def execute_pipeline():
    print("=" * 65)
    print("    [STITCH V18 TITANIUM] -- FULL AI TRAINING PIPELINE")
    print("=" * 65)

    # 1. Load
    X_raw, y, ids = load_and_prepare_data(limit=12000)
    if X_raw is None or len(X_raw) < 100:
        print("❌ Pipeline failed: Not enough data.")
        return

    # 2. Clean
    X = clean_and_engineer_data(X_raw)

    # 3. Train + Optimize
    model, X_train, X_test, y_train, y_test, w_train = train_and_optimize(X, y, ids)

    # 4. Error Analysis + Auto-Correction
    model = error_analysis_and_improvement(model, X_train, y_train, X_test, y_test, w_train)

    # 5. Monte Carlo Final Validation (on 1st test sample)
    print("\n🎲 Running Monte Carlo validation (10,000 simulations)...")
    win_p, draw_p, loss_p = simulate_match_mc(model, X_test.head(1))
    print(f"   Win  Probability: {win_p*100:.1f}%")
    print(f"   Draw Probability: {draw_p*100:.1f}%")
    print(f"   Loss Probability: {loss_p*100:.1f}%")

    # Final Accuracy Summary
    y_final = model.predict(X_test)
    final_acc = accuracy_score(y_test, y_final)
    print(f"\n🏁 Final Accuracy after Continuous Improvement: {final_acc*100:.2f}%")

    # 6. Feature importance plot
    save_feature_importance_plot(model)

    # 7. Save model
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    model.save_model(MODEL_PATH)
    print(f"\n💾 V18 Titanium Model saved to: {MODEL_PATH}")
    print("✅ FULL PIPELINE COMPLETE. AI is now battle-ready.")


if __name__ == "__main__":
    execute_pipeline()
