"""
[TITANIUM V5] Pre-match prediction model.
Features = team historical averages of DB column stats (no current-match stats).
Solves the root problem: _get_avg_hist always returns 0 for archive data.
"""
import sqlite3, json, os, sys, warnings, numpy as np, collections
import xgboost as xgb
from sklearn.metrics import accuracy_score, log_loss
warnings.filterwarnings("ignore")

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE, 'data', 'historical_archive.sqlite')
MODEL_PATH = os.path.join(BASE, 'models', 'titanium_v5.json')

os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)

ROLLING_WINDOW = 5
MIN_HISTORY = 2
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

def load_all_matches():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT * FROM archive_matches 
        WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL
        ORDER BY startTimestamp ASC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]

def extract_match_stats(row):
    """Extract raw stats from a single match row."""
    rd = dict(row)
    stats = {}
    fdb = lambda c: _f(rd.get(c), 0.0)
    stats['possession'] = fdb('home_possession')
    stats['shots'] = fdb('home_shots')
    stats['sot'] = fdb('home_shots_on_target')
    stats['soff'] = fdb('home_shots_off')
    stats['corners'] = fdb('home_corners')
    stats['fouls'] = fdb('home_fouls')
    stats['xg'] = fdb('home_xg')
    stats['goals_scored'] = fdb('scoreHome')
    stats['goals_conceded'] = fdb('scoreAway')
    stats['result'] = 1 if _f(rd.get('scoreHome'),0) > _f(rd.get('scoreAway'),0) else 0 if _f(rd.get('scoreHome'),0) < _f(rd.get('scoreAway'),0) else 0.5
    stats['points'] = 3 if stats['result'] == 1 else 1 if stats['result'] == 0.5 else 0
    
    sb = rd.get('stats_blob')
    if sb:
        try:
            data = json.loads(sb)
            if isinstance(data, dict):
                for k in STATS_KEYS:
                    stats[f'sb_{k}'] = (float(data.get(f'{k}_home', 0)) + float(data.get(f'{k}_away', 0))) / 2
        except: pass
    
    return stats

def build_team_index(rows):
    """Build a mapping of team -> list of (timestamp, match_index, stats)."""
    team_idx = collections.defaultdict(list)
    for i, row in enumerate(rows):
        h, a = row.get('homeTeam'), row.get('awayTeam')
        ts = row.get('startTimestamp', 0) or 0
        stats_h = extract_match_stats(row)
        stats_a = extract_match_stats_away(row)
        team_idx[h].append((ts, i, stats_h))
        team_idx[a].append((ts, i, stats_a))
    # Sort each team by timestamp
    for team in team_idx:
        team_idx[team].sort(key=lambda x: x[0])
    return team_idx

def extract_match_stats_away(row):
    """Extract away team stats from a match."""
    rd = dict(row)
    stats = {}
    fdb = lambda c: _f(rd.get(c), 0.0)
    stats['possession'] = fdb('away_possession')
    stats['shots'] = fdb('away_shots')
    stats['sot'] = fdb('away_shots_on_target')
    stats['soff'] = fdb('away_shots_off')
    stats['corners'] = fdb('away_corners')
    stats['fouls'] = fdb('away_fouls')
    stats['xg'] = fdb('away_xg')
    stats['goals_scored'] = fdb('scoreAway')
    stats['goals_conceded'] = fdb('scoreHome')
    stats['result'] = 1 if _f(rd.get('scoreAway'),0) > _f(rd.get('scoreHome'),0) else 0 if _f(rd.get('scoreAway'),0) < _f(rd.get('scoreHome'),0) else 0.5
    stats['points'] = 3 if stats['result'] == 1 else 1 if stats['result'] == 0.5 else 0
    
    sb = rd.get('stats_blob')
    if sb:
        try:
            data = json.loads(sb)
            if isinstance(data, dict):
                for k in STATS_KEYS:
                    stats[f'sb_{k}'] = (float(data.get(f'{k}_home', 0)) + float(data.get(f'{k}_away', 0))) / 2
        except: pass
    
    return stats

def compute_rolling_avg(stats_list, window=ROLLING_WINDOW):
    """Compute average stats from a list of stats dicts."""
    if not stats_list:
        return None
    recent = stats_list[-window:]
    avg = {}
    keys = ['possession', 'shots', 'sot', 'soff', 'corners', 'fouls', 'xg',
            'goals_scored', 'goals_conceded', 'points']
    for k in keys:
        vals = [s[k] for s in recent]
        avg[k] = sum(vals) / len(vals)
    avg['sample_size'] = len(recent)
    
    sb_keys = [f'sb_{k}' for k in STATS_KEYS]
    for k in sb_keys:
        vals = [s.get(k, 0.0) for s in recent if k in s]
        avg[k] = sum(vals) / len(vals) if vals else 0.0
    
    return avg

def main():
    print("[TITANIUM V5] Training pre-match model with rolling historical averages...")
    rows = load_all_matches()
    print(f"Total matches: {len(rows)}")
    
    team_idx = build_team_index(rows)
    print(f"Unique teams: {len(team_idx)}")
    
    FEATURE_NAMES_V5 = [
        'h_poss', 'a_poss', 'poss_diff',
        'h_shots', 'a_shots', 'shots_diff',
        'h_sot', 'a_sot', 'sot_diff',
        'h_soff', 'a_soff',
        'h_corners', 'a_corners',
        'h_fouls', 'a_fouls',
        'h_xg', 'a_xg', 'xg_diff',
        'h_goals_scored', 'a_goals_scored',
        'h_goals_conceded', 'a_goals_conceded',
        'h_pts_per_game', 'a_pts_per_game',
        'h_sample', 'a_sample',
        'total_shots', 'total_sot', 'total_xg',
        'h_sot_rate', 'a_sot_rate',
        'h_xg_per_shot', 'a_xg_per_shot',
    ] + [f"sb_{k}" for k in STATS_KEYS]
    
    X_list, y_list, ts_list, skipped = [], [], [], 0
    
    for i, row in enumerate(rows):
        try:
            h_team, a_team = row.get('homeTeam'), row.get('awayTeam')
            ts = row.get('startTimestamp', 0) or 0
            match_idx = i
            
            # Get historical stats for each team BEFORE this match
            h_list = [s for (t, idx, s) in team_idx.get(h_team, []) if idx < match_idx]
            a_list = [s for (t, idx, s) in team_idx.get(a_team, []) if idx < match_idx]
            
            h_avg = compute_rolling_avg(h_list)
            a_avg = compute_rolling_avg(a_list)
            
            if h_avg is None or a_avg is None:
                skipped += 1
                continue
            if h_avg['sample_size'] < MIN_HISTORY or a_avg['sample_size'] < MIN_HISTORY:
                skipped += 1
                continue
            
            h, a = _f(row.get('scoreHome'), 0), _f(row.get('scoreAway'), 0)
            target = 2 if h > a else 1 if h == a else 0
            
            feats = {
                'h_poss': h_avg['possession'], 'a_poss': a_avg['possession'],
                'poss_diff': h_avg['possession'] - a_avg['possession'],
                'h_shots': h_avg['shots'], 'a_shots': a_avg['shots'],
                'shots_diff': h_avg['shots'] - a_avg['shots'],
                'h_sot': h_avg['sot'], 'a_sot': a_avg['sot'],
                'sot_diff': h_avg['sot'] - a_avg['sot'],
                'h_soff': h_avg['soff'], 'a_soff': a_avg['soff'],
                'h_corners': h_avg['corners'], 'a_corners': a_avg['corners'],
                'h_fouls': h_avg['fouls'], 'a_fouls': a_avg['fouls'],
                'h_xg': h_avg['xg'], 'a_xg': a_avg['xg'],
                'xg_diff': h_avg['xg'] - a_avg['xg'],
                'h_goals_scored': h_avg['goals_scored'],
                'a_goals_scored': a_avg['goals_scored'],
                'h_goals_conceded': h_avg['goals_conceded'],
                'a_goals_conceded': a_avg['goals_conceded'],
                'h_pts_per_game': h_avg['points'],
                'a_pts_per_game': a_avg['points'],
                'h_sample': h_avg['sample_size'],
                'a_sample': a_avg['sample_size'],
                'total_shots': h_avg['shots'] + a_avg['shots'],
                'total_sot': h_avg['sot'] + a_avg['sot'],
                'total_xg': h_avg['xg'] + a_avg['xg'],
                'h_sot_rate': safe_div(h_avg['sot'], h_avg['shots']),
                'a_sot_rate': safe_div(a_avg['sot'], a_avg['shots']),
                'h_xg_per_shot': safe_div(h_avg['xg'], h_avg['shots']),
                'a_xg_per_shot': safe_div(a_avg['xg'], a_avg['shots']),
            }
            for k in STATS_KEYS:
                feats[f'sb_{k}'] = h_avg.get(f'sb_{k}', 0.0) - a_avg.get(f'sb_{k}', 0.0)
            
            vec = [feats.get(f, 0.0) for f in FEATURE_NAMES_V5]
            X_list.append(vec)
            y_list.append(target)
            ts_list.append(ts)
            
        except Exception as e:
            skipped += 1
            if skipped <= 3: print(f"  Skip row {i}: {e}")
    
    print(f"After filtering (min {MIN_HISTORY} prev matches/team): {len(X_list)} matches, skipped {skipped}")
    
    X = np.array(X_list, dtype=float)
    y = np.array(y_list, dtype=int)
    ts = np.array(ts_list)
    
    print(f"Feature matrix: {X.shape}")
    print(f"Class distribution: Home={np.sum(y==2)}, Draw={np.sum(y==1)}, Away={np.sum(y==0)}")
    
    # Time-based split
    sorted_idx = np.argsort(ts)
    X, y = X[sorted_idx], y[sorted_idx]
    split = int(len(X) * 0.75)
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]
    
    print(f"Train: {len(X_train)}, Test: {len(X_test)}")
    X_train = np.nan_to_num(X_train, nan=0.0)
    X_test = np.nan_to_num(X_test, nan=0.0)
    
    # Handle class imbalance with scale_pos_weight-like approach
    class_counts = np.bincount(y_train)
    max_count = class_counts.max()
    sample_weights = np.array([max_count / class_counts[yi] for yi in y_train])
    
    params = {
        'objective': 'multi:softprob',
        'num_class': 3,
        'eval_metric': 'mlogloss',
        'learning_rate': 0.03,
        'max_depth': 6,
        'subsample': 0.80,
        'colsample_bytree': 0.80,
        'min_child_weight': 3,
        'reg_alpha': 0.2,
        'reg_lambda': 1.0,
        'n_estimators': 500,
        'random_state': 42,
        'early_stopping_rounds': 30,
    }
    
    model = xgb.XGBClassifier(**params)
    model.fit(
        X_train, y_train,
        sample_weight=sample_weights,
        eval_set=[(X_train, y_train), (X_test, y_test)],
        verbose=True
    )
    
    # Evaluate
    probs = model.predict_proba(X_test)
    preds = np.argmax(probs, axis=1)
    acc = accuracy_score(y_test, preds)
    ll = log_loss(y_test, probs)
    print(f"\nV5 - Test accuracy: {acc*100:.2f}%, Log loss: {ll:.4f}")
    
    # Confidence bands
    max_probs = np.max(probs, axis=1)
    print(f"\n--- Confidence Bands ---")
    for lo, hi in [(0.3,0.4),(0.4,0.5),(0.5,0.6),(0.6,0.7),(0.7,0.8),(0.8,0.9),(0.9,1.0)]:
        mask = (max_probs >= lo) & (max_probs < hi)
        if mask.sum() == 0: continue
        acc_band = accuracy_score(y_test[mask], preds[mask])
        print(f"  {lo*100:.0f}-{hi*100:.0f}%: {mask.sum()} matches, accuracy={acc_band*100:.1f}%")
    
    # Save
    model.get_booster().save_model(MODEL_PATH)
    print(f"\nModel saved: {MODEL_PATH}")

if __name__ == '__main__':
    main()
