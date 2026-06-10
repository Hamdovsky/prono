import os, json, sqlite3, numpy as np, pandas as pd
import xgboost as xgb
import sys
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path: sys.path.insert(0, current_dir)
from ml_features import extract_ml_features, FEATURE_NAMES_V53, FEATURE_VOLATILITY
from top_analyst_engine import process_match_for_top_analyst
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, log_loss

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
DB_PATH = os.path.join(BASE_DIR, 'data', 'historical_archive.sqlite')
MODEL_PATH = os.path.join(BASE_DIR, 'models', 'stitch_v24_hybrid.json')

def load_data(limit=30000):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    df = pd.read_sql(f"SELECT * FROM archive_matches WHERE scoreHome IS NOT NULL LIMIT {limit}", conn)
    conn.close()
    data, labels = [], []
    for i, row in df.iterrows():
        try:
            rd = dict(row)
            bf = extract_ml_features(rd, fetch_history=False)
            mp = {
                'id': rd.get('sofascore_id'), 'homeTeam': rd.get('homeTeam'), 'awayTeam': rd.get('awayTeam'),
                'league': rd.get('tournament_name'), 'odds_home': rd.get('odds_home') or bf.get('odds_h', 2.0),
                'odds_draw': 3.0, 'odds_away': bf.get('odds_a', 3.0),
                'home_xg': bf.get('h_xg', 0), 'away_xg': bf.get('a_xg', 0),
                'stats': json.loads(rd.get('stats_blob', '[]')),
                'h2h_data': rd.get('h2h_data'), 'odds_movement_24h': rd.get('odds_movement_24h')
            }
            ta = process_match_for_top_analyst(mp)
            ff = {**bf, **ta.get('ml_features', {})}
            data.append([ff.get(f, 0.0) for f in FEATURE_NAMES_V53])
            hg, ag = row['scoreHome'], row['scoreAway']
            labels.append(0 if hg > ag else 1 if hg == ag else 2)
        except: continue
    print(f"[V53] Extracted {len(data)} rows with {len(FEATURE_NAMES_V53)} features")
    return pd.DataFrame(data, columns=FEATURE_NAMES_V53), np.array(labels)

X, y = load_data()
X_train, X_temp, y_train, y_temp = train_test_split(X, y, test_size=0.3, random_state=42)
X_val, X_test, y_val, y_test = train_test_split(X_temp, y_temp, test_size=0.5, random_state=42)

print(f"[V53] Train: {len(X_train)} Val: {len(X_val)} Test: {len(X_test)}")

model = xgb.XGBClassifier(
    objective='multi:softprob', num_class=3, n_estimators=600, max_depth=7,
    learning_rate=0.02, subsample=0.8, colsample_bytree=0.8,
    min_child_weight=3, reg_alpha=0.3, reg_lambda=1.0,
    early_stopping_rounds=50, random_state=42, eval_metric='mlogloss'
)
model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)

y_pred = np.argmax(model.predict_proba(X_test), axis=1)
acc = accuracy_score(y_test, y_pred)
ll = log_loss(y_test, model.predict_proba(X_test))
print(f"[V53] Accuracy: {acc*100:.2f}% | Log Loss: {ll:.4f}")

model.get_booster().save_model(MODEL_PATH)
print(f"[V53] Saved to {MODEL_PATH}")

# Feature importance
imp = model.get_booster().get_score(importance_type='weight')
sorted_imp = sorted(imp.items(), key=lambda x: -x[1])[:15]
print("\n[V53-TOP15] Feature Importance:")
for fname, s in sorted_imp:
    print(f"   {fname}: {s}")
