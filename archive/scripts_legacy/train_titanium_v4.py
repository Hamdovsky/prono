"""
[TITANIUM V4] Retraining with direct DB columns + stats_blob extraction.
No dependency on _get_avg_hist title-case lookup (broken for archive dict format).
Uses time-based train/val split and probability calibration.
"""
import sqlite3, json, os, sys, warnings, numpy as np
import xgboost as xgb
from sklearn.metrics import accuracy_score, log_loss, brier_score_loss
from sklearn.isotonic import IsotonicRegression
from sklearn.model_selection import train_test_split
warnings.filterwarnings("ignore")

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE, 'data', 'historical_archive.sqlite')
MODEL_PATH = os.path.join(BASE, 'models', 'titanium_v4.json')
CAL_PATH = os.path.join(BASE, 'models', 'titanium_v4_calib.json')

os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)

STATS_KEYS = [
    'ball_possession', 'expected_goals', 'total_shots', 'shots_on_target',
    'shots_off_target', 'corner_kicks', 'fouls', 'yellow_cards',
    'goalkeeper_saves', 'tackles', 'interceptions', 'clearances',
    'accurate_passes', 'passes', 'shots_inside_box', 'shots_outside_box',
    'ground_duels_won', 'aerial_duels_won', 'big_chances'
]

def _f(val, default=0.0):
    try:
        if val is None: return float(default)
        if isinstance(val, str):
            s = val.strip()
            if not s or s.lower() in ('none', 'null', 'nan', ''): return float(default)
            return float(s.replace('%', '').split('/')[0])
        return float(val)
    except: return float(default)

def safe_div(a, b):
    return a / b if b and b != 0 else 0.0

def extract_features_from_row(row):
    rd = dict(row)
    feats = {}
    
    # 1. DB columns (always available if not NULL)
    fdb = lambda c: _f(rd.get(c), 0.0)
    feats['h_poss'] = fdb('home_possession')
    feats['a_poss'] = fdb('away_possession')
    feats['h_shots'] = fdb('home_shots')
    feats['a_shots'] = fdb('away_shots')
    feats['h_sot'] = fdb('home_shots_on_target')
    feats['a_sot'] = fdb('away_shots_on_target')
    feats['h_soff'] = fdb('home_shots_off')
    feats['a_soff'] = fdb('away_shots_off')
    feats['h_corners'] = fdb('home_corners')
    feats['a_corners'] = fdb('away_corners')
    feats['h_fouls'] = fdb('home_fouls')
    feats['a_fouls'] = fdb('away_fouls')
    feats['h_xg'] = fdb('home_xg')
    feats['a_xg'] = fdb('away_xg')
    
    # 2. Differences & ratios
    feats['poss_diff'] = feats['h_poss'] - feats['a_poss']
    feats['shots_diff'] = feats['h_shots'] - feats['a_shots']
    feats['sot_diff'] = feats['h_sot'] - feats['a_sot']
    feats['xg_diff'] = feats['h_xg'] - feats['a_xg']
    feats['total_shots'] = feats['h_shots'] + feats['a_shots']
    feats['total_sot'] = feats['h_sot'] + feats['a_sot']
    feats['total_xg'] = feats['h_xg'] + feats['a_xg']
    feats['h_sot_rate'] = safe_div(feats['h_sot'], feats['h_shots'])
    feats['a_sot_rate'] = safe_div(feats['a_sot'], feats['a_shots'])
    feats['h_xg_per_shot'] = safe_div(feats['h_xg'], feats['h_shots'])
    feats['a_xg_per_shot'] = safe_div(feats['a_xg'], feats['a_shots'])
    feats['h_efficiency'] = safe_div(fdb('scoreHome'), feats['h_xg']) if feats['h_xg'] > 0 else 1.0
    feats['a_efficiency'] = safe_div(fdb('scoreAway'), feats['a_xg']) if feats['a_xg'] > 0 else 1.0
    
    # 3. Stats_blob keys (snake_case, dict format)
    stats = {}
    sb = rd.get('stats_blob')
    if sb:
        try:
            data = json.loads(sb)
            if isinstance(data, dict):
                for k, v in data.items():
                    stats[k] = _f(v)
        except: pass
    
    for key in STATS_KEYS:
        hk, ak = f"{key}_home", f"{key}_away"
        feats[f"sb_{key}_h"] = stats.get(hk, 0.0)
        feats[f"sb_{key}_a"] = stats.get(ak, 0.0)
    
    # 4. H2H data
    feats['h2h_home_wins'] = 0
    feats['h2h_draws'] = 0
    feats['h2h_away_wins'] = 0
    feats['h2h_total'] = 0
    feats['h2h_avg_goals'] = 0
    h2h_raw = rd.get('h2h_data')
    if h2h_raw:
        try:
            h2h = json.loads(h2h_raw) if isinstance(h2h_raw, str) else h2h_raw
            if isinstance(h2h, dict):
                matches = h2h.get('matches', h2h.get('results', []))
                if isinstance(matches, list) and len(matches) > 0:
                    for m in matches:
                        hs, aw = _f(m.get('homeScore', m.get('scoreHome'), 0)), _f(m.get('awayScore', m.get('scoreAway'), 0))
                        if hs > aw: feats['h2h_home_wins'] += 1
                        elif hs == aw: feats['h2h_draws'] += 1
                        else: feats['h2h_away_wins'] += 1
                    feats['h2h_total'] = len(matches)
                    total_goals = sum(_f(m.get('homeScore', m.get('scoreHome'), 0)) + _f(m.get('awayScore', m.get('scoreAway'), 0)) for m in matches)
                    feats['h2h_avg_goals'] = safe_div(total_goals, len(matches))
        except: pass
    
    feats['h2h_home_rate'] = safe_div(feats['h2h_home_wins'], max(feats['h2h_total'], 1))
    feats['h2h_draw_rate'] = safe_div(feats['h2h_draws'], max(feats['h2h_total'], 1))
    
    return feats

FEATURE_NAMES_V4 = [
    # DB columns
    'h_poss', 'a_poss', 'poss_diff',
    'h_shots', 'a_shots', 'shots_diff',
    'h_sot', 'a_sot', 'sot_diff',
    'h_soff', 'a_soff',
    'h_corners', 'a_corners',
    'h_fouls', 'a_fouls',
    'h_xg', 'a_xg', 'xg_diff',
    'total_shots', 'total_sot', 'total_xg',
    'h_sot_rate', 'a_sot_rate',
    'h_xg_per_shot', 'a_xg_per_shot',
    'h_efficiency', 'a_efficiency',
    # Stats blob keys
] + [f"sb_{k}_{s}" for k in STATS_KEYS for s in ('h', 'a')] + [
    # H2H
    'h2h_home_wins', 'h2h_draws', 'h2h_away_wins', 'h2h_total',
    'h2h_avg_goals', 'h2h_home_rate', 'h2h_draw_rate'
]

def load_data():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT * FROM archive_matches 
        WHERE stats_blob IS NOT NULL AND scoreHome IS NOT NULL AND scoreAway IS NOT NULL
        ORDER BY startTimestamp ASC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]

def main():
    print("[TITANIUM V4] Training with direct DB + stats_blob features...")
    rows = load_data()
    print(f"Total rows: {len(rows)}")
    
    X_list, y_list, ts_list = [], [], []
    skipped = 0
    for i, row in enumerate(rows):
        try:
            feats = extract_features_from_row(row)
            vec = [feats.get(f, 0.0) for f in FEATURE_NAMES_V4]
            h = _f(row.get('scoreHome'), 0)
            a = _f(row.get('scoreAway'), 0)
            target = 2 if h > a else 1 if h == a else 0
            X_list.append(vec)
            y_list.append(target)
            ts_list.append(row.get('startTimestamp', 0) or 0)
        except Exception as e:
            skipped += 1
            if skipped < 5: print(f"  Skip row {i}: {e}")
    
    if skipped: print(f"Skipped: {skipped}")
    
    X = np.array(X_list, dtype=float)
    y = np.array(y_list, dtype=int)
    ts = np.array(ts_list)
    
    print(f"Feature matrix: {X.shape}")
    print(f"Class distribution: Home={np.sum(y==2)}, Draw={np.sum(y==1)}, Away={np.sum(y==0)}")
    
    # Time-based split: train on older 75%, test on newer 25%
    sorted_idx = np.argsort(ts)
    X, y = X[sorted_idx], y[sorted_idx]
    split = int(len(X) * 0.75)
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]
    
    print(f"Train: {len(X_train)}, Test: {len(X_test)}")
    
    # Handle missing values
    X_train = np.nan_to_num(X_train, nan=0.0)
    X_test = np.nan_to_num(X_test, nan=0.0)
    
    # Train with robust params
    params = {
        'objective': 'multi:softprob',
        'num_class': 3,
        'eval_metric': 'mlogloss',
        'learning_rate': 0.03,
        'max_depth': 7,
        'subsample': 0.80,
        'colsample_bytree': 0.80,
        'min_child_weight': 3,
        'reg_alpha': 0.2,
        'reg_lambda': 1.0,
        'n_estimators': 500,
        'random_state': 42
    }
    
    model = xgb.XGBClassifier(**params)
    model.fit(
        X_train, y_train,
        eval_set=[(X_train, y_train), (X_test, y_test)],
        verbose=True
    )
    
    # Evaluate raw model
    probs_train = model.predict_proba(X_train)
    probs_test = model.predict_proba(X_test)
    preds_test = np.argmax(probs_test, axis=1)
    
    acc_raw = accuracy_score(y_test, preds_test)
    ll_raw = log_loss(y_test, probs_test)
    print(f"\nRaw model - Test accuracy: {acc_raw*100:.2f}%, Log loss: {ll_raw:.4f}")
    
    # Calibration: Isotonic regression per class
    iso_models = []
    for c in range(3):
        iso = IsotonicRegression(out_of_bounds='clip')
        y_c = (y_train == c).astype(float)
        iso.fit(probs_train[:, c], y_c)
        iso_models.append(iso)
    
    probs_cal = np.zeros_like(probs_test)
    for c in range(3):
        probs_cal[:, c] = iso_models[c].predict(probs_test[:, c])
    # Renormalize
    row_sums = probs_cal.sum(axis=1)
    probs_cal = probs_cal / row_sums[:, np.newaxis]
    
    preds_cal = np.argmax(probs_cal, axis=1)
    acc_cal = accuracy_score(y_test, preds_cal)
    ll_cal = log_loss(y_test, probs_cal)
    print(f"Calibrated - Test accuracy: {acc_cal*100:.2f}%, Log loss: {ll_cal:.4f}")
    
    # Per-confidence band calibration check
    print(f"\n--- Confidence Bands (calibrated) ---")
    max_probs = np.max(probs_cal, axis=1)
    for thresh in [(0.4, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 0.9), (0.9, 1.0)]:
        lo, hi = thresh
        mask = (max_probs >= lo) & (max_probs < hi)
        if mask.sum() == 0: continue
        acc_band = accuracy_score(y_test[mask], preds_cal[mask])
        print(f"  {lo*100:.0f}-{hi*100:.0f}%: {mask.sum()} matches, accuracy={acc_band*100:.1f}%")
    
    # Save model
    model.get_booster().save_model(MODEL_PATH)
    print(f"\nModel saved: {MODEL_PATH}")
    
    # Save calibration models as simple coefficient arrays
    calib_data = {}
    for c in range(3):
        iso = iso_models[c]
        calib_data[f"class_{c}_thresholds"] = iso.X_thresholds_.tolist()
        calib_data[f"class_{c}_y"] = iso.y_thresholds_.tolist()
    with open(CAL_PATH, 'w') as f:
        json.dump(calib_data, f)
    print(f"Calibration saved: {CAL_PATH}")
    
    # Show per-class metrics
    for c, label in enumerate(['Away', 'Draw', 'Home']):
        mask = y_test == c
        if mask.sum() == 0: continue
        acc_c = accuracy_score(y_test[mask], preds_cal[mask])
        print(f"  {label}: {mask.sum()} matches, accuracy={acc_c*100:.1f}%")

if __name__ == '__main__':
    main()
