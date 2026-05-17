import sqlite3
import pandas as pd
import numpy as np
import json
import os
from sklearn.preprocessing import StandardScaler
import joblib

DB_TACTICAL = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'tactical.db')
DB_ARCHIVE = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'historical_archive.sqlite')
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'neural_data')

def extract_stats(stats_json):
    if not stats_json: return {}
    try:
        stats = json.loads(stats_json)
        res = {}
        for item in stats:
            cat = item.get('category', 'Unknown')
            val_h = item.get('homeValue', '0')
            val_a = item.get('awayValue', '0')
            def _clean(v):
                if isinstance(v, str):
                    try: return float(v.replace('%', '').split('/')[0])
                    except: return 0.0
                return float(v) if v is not None else 0.0
            res[f"{cat}_home"] = _clean(val_h)
            res[f"{cat}_away"] = _clean(val_a)
        return res
    except: return {}

def prepare_dnn_data():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    dataset = []

    # 1. ARCHIVE (Majority of data)
    if os.path.exists(DB_ARCHIVE):
        print(f"📦 Extracting from {DB_ARCHIVE}...")
        conn = sqlite3.connect(DB_ARCHIVE)
        # We take all matches that have stats
        df = pd.read_sql_query("SELECT stats_blob, scoreHome, scoreAway FROM archive_matches WHERE stats_blob IS NOT NULL", conn)
        conn.close()
        
        for _, r in df.iterrows():
            stats = extract_stats(r['stats_blob'])
            if not stats: continue
            
            # Feature Vector: Selection of core indicators
            vec = [
                stats.get('Ball possession_home', 50),
                stats.get('Total shots_home', 10),
                stats.get('Shots on target_home', 3),
                stats.get('Big chances_home', 1),
                stats.get('Corner kicks_home', 4),
                stats.get('Ball possession_away', 50),
                stats.get('Total shots_away', 10),
                stats.get('Shots on target_away', 3),
                stats.get('Big chances_away', 1),
                stats.get('Corner kicks_away', 4)
            ]
            
            sh, sa = r['scoreHome'], r['scoreAway']
            target = 2 if sh > sa else (1 if sh == sa else 0)
            dataset.append({'X': vec, 'y': target})

    # 2. TACTICAL (Real-match data)
    if os.path.exists(DB_TACTICAL):
        print(f"📦 Extracting from {DB_TACTICAL}...")
        conn = sqlite3.connect(DB_TACTICAL)
        df = pd.read_sql_query("SELECT possession_home, possession_away, shots_on_target_home, shots_on_target_away, corners_home, corners_away, scoreHome, scoreAway FROM matches WHERE scoreHome IS NOT NULL", conn)
        conn.close()
        for _, r in df.iterrows():
            vec = [
                r['possession_home'] or 50,
                12, # Shots proxy
                r['shots_on_target_home'] or 4,
                2, # Big chances proxy
                r['corners_home'] or 5,
                r['possession_away'] or 50,
                10,
                r['shots_on_target_away'] or 3,
                1,
                r['corners_away'] or 4
            ]
            sh, sa = r['scoreHome'], r['scoreAway']
            target = 2 if sh > sa else (1 if sh == sa else 0)
            dataset.append({'X': vec, 'y': target})

    if not dataset:
        print("❌ Dataset empty!")
        return

    X = np.array([d['X'] for d in dataset])
    y = np.array([d['y'] for d in dataset])

    print(f"✅ Prepared {len(X)} samples with {X.shape[1]} features.")

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    np.save(os.path.join(OUTPUT_DIR, 'X_dnn.npy'), X_scaled)
    np.save(os.path.join(OUTPUT_DIR, 'y_dnn.npy'), y)
    joblib.dump(scaler, os.path.join(OUTPUT_DIR, 'scaler_dnn.pkl'))
    print(f"💾 Feature Space Saved: {OUTPUT_DIR}")

if __name__ == "__main__":
    prepare_dnn_data()
