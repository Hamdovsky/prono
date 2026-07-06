"""
grid_search_v56.py — Quick hyperparameter grid search for V56
Tests combinations on 20K samples, picks best, updates auto_retrain.py
"""
import sys, os, json, math, itertools, time
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'core'))

from pg_connector import query
from ml_features import extract_v56_features

print("Fetching training data...")
rows = query("""
    SELECT f.id, ht.name AS home_team, at.name AS away_team,
           f.goals_home, f.goals_away,
           o.home_win AS odds_home, o.draw AS odds_draw, o.away_win AS odds_away,
           f.date,
           m.home_shots_total AS home_shots, m.away_shots_total AS away_shots,
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
        FROM soccer_odds ORDER BY fixture_id, CASE bookmaker WHEN 'Pinnacle' THEN 0 WHEN 'Bet365' THEN 1 ELSE 2 END
    ) o ON o.fixture_id = f.id
    LEFT JOIN (
        SELECT DISTINCT ON (team_name) team_name, attack_rating, defense_rating
        FROM league_model_parameters WHERE team_name IS NOT NULL AND attack_rating IS NOT NULL
        ORDER BY team_name, num_matches DESC
    ) hp ON hp.team_name = ht.name
    LEFT JOIN (
        SELECT DISTINCT ON (team_name) team_name, attack_rating, defense_rating
        FROM league_model_parameters WHERE team_name IS NOT NULL AND attack_rating IS NOT NULL
        ORDER BY team_name, num_matches DESC
    ) ap ON ap.team_name = at.name
    WHERE f.goals_home IS NOT NULL AND f.goals_away IS NOT NULL AND m.home_shots_total IS NOT NULL
    ORDER BY f.date ASC
    LIMIT 25000
""") or []
print(f"Loaded {len(rows)} rows")

import xgboost as xgb
from sklearn.metrics import accuracy_score

# Build features
X, y = [], []
for i in range(len(rows)):
    if i < 10: continue
    r = rows[i]
    gh = float(r.get('goals_home', 0) or 0)
    ga = float(r.get('goals_away', 0) or 0)
    label = 0 if gh > ga else (2 if gh < ga else 1)
    feat = extract_v56_features(r, rows, i)
    feat = [0.0 if (math.isnan(v) or math.isinf(v)) else v for v in feat]
    X.append(feat)
    y.append(label)

X = np.array(X, dtype=np.float32)
y = np.array(y, dtype=np.int32)
print(f"Features: {X.shape}")

# Chrono split (80/20 for grid search speed)
n = len(X)
split = int(n * 0.8)
X_tr, y_tr = X[:split], y[:split]
X_val, y_val = X[split:], y[split:]
print(f"Train: {len(X_tr)}, Val: {len(X_val)}")

# Grid
param_grid = {
    'max_depth': [4, 6, 8],
    'learning_rate': [0.05, 0.08, 0.12],
    'subsample': [0.7, 0.8],
    'colsample_bytree': [0.6, 0.8],
    'min_child_weight': [2, 3, 5],
    'reg_alpha': [0.1, 0.5, 1.0],
    'reg_lambda': [0.5, 1.0, 2.0],
}

keys = list(param_grid.keys())
best_acc = 0
best_params = None

print("\nGrid search (testing random combinations)...")
import random
random.seed(42)

for trial in range(40):
    params = {
        'objective': 'multi:softprob',
        'num_class': 3,
        'eval_metric': 'mlogloss',
    }
    for k in keys:
        params[k] = random.choice(param_grid[k])

    dtrain = xgb.DMatrix(X_tr, label=y_tr)
    dval = xgb.DMatrix(X_val, label=y_val)

    model = xgb.train(
        params, dtrain, num_boost_round=300,
        evals=[(dval, 'val')], early_stopping_rounds=30,
        verbose_eval=0
    )
    yp = model.predict(dval)
    ypc = np.argmax(yp, axis=1)
    acc = accuracy_score(y_val, ypc)

    if acc > best_acc:
        best_acc = acc
        best_params = dict(params)
        print(f"  Trial {trial+1}: acc={acc:.4f} BEST ← {params}")
    else:
        if trial % 10 == 0:
            print(f"  Trial {trial+1}: acc={acc:.4f}")

print(f"\nBest accuracy: {best_acc:.4f}")
print(f"Best params: {best_params}")

# Update auto_retrain.py
if best_params:
    auto_retrain_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scripts', 'auto_retrain.py')
    with open(auto_retrain_path) as f:
        content = f.read()

    new_hp = f"""V56_HYPERPARAMS = {{
    'max_depth': {best_params['max_depth']},
    'learning_rate': {best_params['learning_rate']},
    'n_estimators': 500,
    'subsample': {best_params['subsample']},
    'colsample_bytree': {best_params['colsample_bytree']},
    'min_child_weight': {best_params['min_child_weight']},
    'gamma': 0.1,
    'reg_alpha': {best_params['reg_alpha']},
    'reg_lambda': {best_params['reg_lambda']},
    'eval_metric': 'mlogloss',
    'early_stopping_rounds': 50,
}}"""

    import re
    content = re.sub(
        r"V56_HYPERPARAMS = \{[^}]+\}",
        new_hp,
        content,
        flags=re.DOTALL
    )
    with open(auto_retrain_path, 'w') as f:
        f.write(content)
    print(f"Updated {auto_retrain_path}")
