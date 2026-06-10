#!/usr/bin/env python3
"""
Train Live Goal Prediction Model (XGBoost)

Generates synthetic in-play snapshots from historical match data,
using Poisson goal-timing simulation from final xG/stats.

Output: models/live_goal_xgb.json
"""

import json
import math
import random
import sqlite3
import sys
import os
from datetime import datetime

import numpy as np
import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, roc_auc_score, brier_score_loss

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'historical_archive.sqlite')
MODEL_PATH = os.path.join(os.path.dirname(__file__), '..', 'models', 'live_goal_xgb.json')

random.seed(42)
np.random.seed(42)

# ── HELPER: Simulate goal timings from match stats ──────────────────

def simulate_goal_minutes(xg_home, xg_away, total_minutes=95):
    """Poisson process: return list of (minute, scoring_team) tuples."""
    events = []
    # Home goals: intensity = xg_home / 95
    lam_h = xg_home / total_minutes
    t = 0
    while t < total_minutes:
        t += np.random.exponential(1 / lam_h) if lam_h > 0 else 999
        if t < total_minutes:
            events.append((int(t), 'home'))
    # Away goals
    lam_a = xg_away / total_minutes
    t = 0
    while t < total_minutes:
        t += np.random.exponential(1 / lam_a) if lam_a > 0 else 999
        if t < total_minutes:
            events.append((int(t), 'away'))
    events.sort(key=lambda x: x[0])
    return events

def generate_snapshots(match):
    """Generate synthetic in-play snapshots from a completed match."""
    try:
        home_xg = match.get('home_xg') or 0
        away_xg = match.get('away_xg') or 0
        home_sot = match.get('home_shots_on_target') or 0
        away_sot = match.get('away_shots_on_target') or 0
        home_poss = match.get('home_possession') or 50
        home_score_final = match.get('scoreHome') or 0
        away_score_final = match.get('scoreAway') or 0
        league = match.get('tournament_name') or match.get('league') or 'Unknown'

        # Simulate goal timeline
        goal_events = simulate_goal_minutes(home_xg, away_xg)

        # Build snapshots at regular intervals
        snapshots = []
        for minute in range(5, 96, 5):
            # Count goals up to this minute
            goals_sofar = [g for g in goal_events if g[0] <= minute]
            score_h = sum(1 for g in goals_sofar if g[1] == 'home')
            score_a = sum(1 for g in goals_sofar if g[1] == 'away')

            # xG consumed so far (proportional to time)
            consumed_ratio = minute / 95
            xg_h_consumed = home_xg * consumed_ratio
            xg_a_consumed = away_xg * consumed_ratio

            # Shots so far (proportional)
            sot_h_sofar = int(home_sot * consumed_ratio)
            sot_a_sofar = int(away_sot * consumed_ratio)

            # Goal in next 5 minutes?
            next5_goals = [g for g in goal_events if minute < g[0] <= minute + 5]
            goal_in_next5 = 1 if next5_goals else 0

            score_diff = score_h - score_a
            total_goals = score_h + score_a
            half = 0 if minute <= 45 else 1

            snapshots.append({
                'minute': minute,
                'score_home': score_h,
                'score_away': score_a,
                'score_diff': score_diff,
                'total_goals': total_goals,
                'xg_h_remaining': home_xg - xg_h_consumed,
                'xg_a_remaining': away_xg - xg_a_consumed,
                'xg_h_consumed': xg_h_consumed,
                'xg_a_consumed': xg_a_consumed,
                'sot_h_sofar': sot_h_sofar,
                'sot_a_sofar': sot_a_sofar,
                'possession_h': home_poss,
                'possession_diff': home_poss - (100 - home_poss),
                'half': half,
                'minutes_remaining': 95 - minute,
                'goal_in_next5': goal_in_next5,
                'goal_in_next10': 1 if [g for g in goal_events if minute < g[0] <= minute + 10] else 0,
                'goal_in_next15': 1 if [g for g in goal_events if minute < g[0] <= minute + 15] else 0,
                'league': league
            })

        return snapshots
    except Exception:
        return []

# ── FEATURE ENGINEERING ────────────────────────────────────────────

LEAGUE_TIER_MAP = {
    'premier league': 1, 'england premier league': 1,
    'la liga': 1, 'laliga': 1, 'spain la liga': 1,
    'serie a': 1, 'italy serie a': 1,
    'bundesliga': 1, 'germany bundesliga': 1,
    'ligue 1': 1, 'france ligue 1': 1,
    'eredivisie': 2, 'netherlands eredivisie': 2,
    'primeira liga': 2, 'portugal primeira liga': 2,
    'belgium pro league': 3, 'jupiler pro league': 3,
    'super lig': 2, 'turkey super lig': 2,
    'russian premier league': 2,
    'scottish premiership': 3,
    'championship': 2, 'england championship': 2,
    'serie b': 3, 'italy serie b': 3,
    '2. bundesliga': 3, 'germany 2. bundesliga': 3,
    'ligue 2': 3, 'france ligue 2': 3,
    'segunda division': 3, 'spain segunda division': 3,
    'mls': 2, 'major league soccer': 2,
    'j1 league': 2, 'jleague': 2,
    'k league 1': 3, 'kleague': 3,
    'a league': 3, 'a-league': 3,
    'liga mx': 2, 'mexico liga mx': 2,
    'argentine primera division': 2, 'primera division': 2,
    'brasileiro serie a': 2, 'brazil serie a': 2,
    'chile primera division': 3,
    'colombia primera a': 3,
}

def get_league_tier(league_name):
    if not league_name:
        return 3
    key = league_name.lower().strip()
    return LEAGUE_TIER_MAP.get(key, 3)

def extract_features(snap):
    return [
        snap['minute'],
        snap['score_diff'],
        snap['total_goals'],
        snap['xg_h_remaining'],
        snap['xg_a_remaining'],
        snap['xg_h_consumed'],
        snap['xg_a_consumed'],
        snap['sot_h_sofar'],
        snap['sot_a_sofar'],
        snap['possession_h'],
        snap['possession_diff'],
        snap['half'],
        snap['minutes_remaining'],
    ]

FEATURE_NAMES = [
    'minute', 'score_diff', 'total_goals',
    'xg_h_remaining', 'xg_a_remaining',
    'xg_h_consumed', 'xg_a_consumed',
    'sot_h_sofar', 'sot_a_sofar',
    'possession_h', 'possession_diff',
    'half', 'minutes_remaining',
]

# ── MAIN ───────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("LIVE GOAL PREDICTION MODEL TRAINING")
    print(datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    print("=" * 60)

    # 1) Load historical matches
    if not os.path.exists(DB_PATH):
        print(f"[!] Database not found: {DB_PATH}")
        # Fall back to tactical.db
        alt_path = os.path.join(os.path.dirname(__file__), '..', 'data', 'tactical.db')
        if os.path.exists(alt_path):
            print(f"[*] Falling back to: {alt_path}")
            conn = sqlite3.connect(alt_path)
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM historical_matches ORDER BY RANDOM() LIMIT 5000")
            rows = cursor.fetchall()
            col_names = [desc[0] for desc in cursor.description]
            matches = [dict(zip(col_names, r)) for r in rows]
        else:
            print("[!] No data source available. Generating synthetic training data.")
            matches = []
    else:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM archive_matches ORDER BY RANDOM() LIMIT 5000")
        rows = cursor.fetchall()
        col_names = [desc[0] for desc in cursor.description]
        matches = [dict(zip(col_names, r)) for r in rows]

    print(f"[*] Loaded {len(matches)} historical matches")

    # 2) Generate snapshots
    all_snapshots = []
    for m in matches:
        snaps = generate_snapshots(m)
        all_snapshots.extend(snaps)

    print(f"[*] Generated {len(all_snapshots)} synthetic snapshots")

    if len(all_snapshots) < 100:
        print("[!] Too few snapshots. Generating synthetic matches...")
        # Generate synthetic matches to bootstrap
        for _ in range(200):
            fake_match = {
                'home_xg': np.random.uniform(0.2, 2.5),
                'away_xg': np.random.uniform(0.2, 2.0),
                'home_shots_on_target': int(np.random.uniform(1, 10)),
                'away_shots_on_target': int(np.random.uniform(1, 8)),
                'home_possession': np.random.uniform(35, 65),
                'scoreHome': int(np.random.poisson(1.5)),
                'scoreAway': int(np.random.poisson(1.2)),
                'tournament_name': random.choice(['Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Eredivisie']),
            }
            all_snapshots.extend(generate_snapshots(fake_match))
        print(f"[*] After synthetic boost: {len(all_snapshots)} snapshots")

    if len(all_snapshots) < 200:
        print("[X] Still insufficient data. Exiting.")
        sys.exit(1)

    # 3) Prepare features
    X = np.array([extract_features(s) for s in all_snapshots])
    y_next5 = np.array([s['goal_in_next5'] for s in all_snapshots])
    y_next10 = np.array([s['goal_in_next10'] for s in all_snapshots])

    # Target distribution
    goal_rate = y_next5.mean() * 100
    print(f"[*] Goal rate in next 5 min: {goal_rate:.1f}%")

    # 4) Train/val split
    X_train, X_val, y_train, y_val = train_test_split(
        X, y_next5, test_size=0.2, random_state=42, stratify=y_next5
    )

    # 5) Train XGBoost
    model = xgb.XGBClassifier(
        n_estimators=300,
        max_depth=5,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=3,
        scale_pos_weight=(1 - y_next5.mean()) / max(y_next5.mean(), 0.01),
        eval_metric='logloss',
        use_label_encoder=False,
        random_state=42
    )

    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        verbose=False
    )

    # 6) Evaluate
    y_pred = model.predict(X_val)
    y_proba = model.predict_proba(X_val)[:, 1]

    accuracy = accuracy_score(y_val, y_pred)
    auc = roc_auc_score(y_val, y_proba)
    brier = brier_score_loss(y_val, y_proba)

    print(f"\n[*] Validation Results (next 5 min):")
    print(f"    Accuracy:  {accuracy:.4f}")
    print(f"    AUC-ROC:   {auc:.4f}")
    print(f"    Brier:     {brier:.4f}")

    # 7) Feature importance
    importances = list(zip(FEATURE_NAMES, model.feature_importances_))
    importances.sort(key=lambda x: x[1], reverse=True)
    print("\n[*] Top 10 Features:")
    for name, imp in importances[:10]:
        print(f"    {name:20s} {imp:.4f}")

    # 8) Save model
    model.get_booster().save_model(MODEL_PATH)
    print(f"\n[OK] Model saved to: {MODEL_PATH}")

    # 9) Also save metadata
    meta = {
        'model_type': 'xgboost-live-goal',
        'target': 'goal_in_next5min',
        'version': '1.0',
        'features': FEATURE_NAMES,
        'validation_accuracy': float(accuracy),
        'validation_auc': float(auc),
        'validation_brier': float(brier),
        'goal_rate_pct': float(goal_rate),
        'synthetic_snapshots': len(all_snapshots),
        'historical_matches': len(matches),
        'trained_at': datetime.now().isoformat()
    }
    meta_path = MODEL_PATH.replace('.json', '_meta.json')
    with open(meta_path, 'w') as f:
        json.dump(meta, f, indent=2)
    print(f"[OK] Metadata saved to: {meta_path}")

    # 10) Also train next-10 and next-15 models
    for target_name, y_target in [('next10', y_next10), ('next15', np.array([s['goal_in_next15'] for s in all_snapshots]))]:
        model_n = xgb.XGBClassifier(
            n_estimators=200, max_depth=4, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8,
            scale_pos_weight=(1 - y_target.mean()) / max(y_target.mean(), 0.01),
            eval_metric='logloss', use_label_encoder=False, random_state=42
        )
        yt_train, yt_val = train_test_split(y_target, test_size=0.2, random_state=42, stratify=y_target)
        Xt_train, Xt_val = train_test_split(X, test_size=0.2, random_state=42)
        # Re-align for proper split
        Xt_train, Xt_val, yt_train, yt_val = train_test_split(
            X, y_target, test_size=0.2, random_state=42, stratify=y_target
        )
        model_n.fit(Xt_train, yt_train, eval_set=[(Xt_val, yt_val)], verbose=False)
        model_path_n = MODEL_PATH.replace('.json', f'_{target_name}.json')
        model_n.get_booster().save_model(model_path_n)
        auc_n = roc_auc_score(yt_val, model_n.predict_proba(Xt_val)[:, 1])
        print(f"[OK] {target_name} model saved (AUC: {auc_n:.4f})")

    print("\n[*] Training complete!")
    return 0

if __name__ == '__main__':
    sys.exit(main())
