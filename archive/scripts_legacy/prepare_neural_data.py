import sqlite3
import pandas as pd
import numpy as np
import json
import os
from sklearn.preprocessing import StandardScaler
import joblib
from datetime import datetime

DB_TACTICAL = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'tactical.db')
DB_ARCHIVE = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'historical_archive.sqlite')
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'neural_data')

def extract_features_from_json(stats_blob):
    if not stats_blob: return None
    try:
        stats = json.loads(stats_blob)
        feats = {}
        for item in stats:
            cat = item.get('category', 'Unknown')
            val_h = item.get('homeValue', '0')
            val_a = item.get('awayValue', '0')
            def _clean(v):
                if isinstance(v, str):
                    try: return float(str(v).replace('%', '').split('/')[0])
                    except: return 0.0
                return float(v) if v is not None else 0.0
            feats[cat] = (_clean(val_h), _clean(val_a))
        return feats
    except: return None

def get_ts(raw):
    if isinstance(raw, int): return raw
    if isinstance(raw, float): return int(raw)
    try:
        s = str(raw)
        if 'T' in s:
            dt_str = s.split('.')[0].replace('Z', '')
            return int(datetime.fromisoformat(dt_str).timestamp())
        return int(float(s))
    except: return 0

def prepare_sequential_data(sequence_length=3):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    all_matches = []

    if os.path.exists(DB_TACTICAL):
        print("Extracting from tactical.db...")
        conn = sqlite3.connect(DB_TACTICAL)
        df = pd.read_sql_query("SELECT homeTeam, awayTeam, scoreHome, scoreAway, timestamp, possession_home, shots_on_target_home, corners_home, home_xg, possession_away, shots_on_target_away, corners_away, away_xg FROM matches WHERE scoreHome IS NOT NULL", conn)
        conn.close()
        for _, r in df.iterrows():
            stats = {
                'Ball possession': (r['possession_home'] or 50, r['possession_away'] or 50),
                'Shots on target': (r['shots_on_target_home'] or 0, r['shots_on_target_away'] or 0),
                'Corner kicks': (r['corners_home'] or 0, r['corners_away'] or 0),
                'Expected goals': (r['home_xg'] or 0.0, r['away_xg'] or 0.0)
            }
            all_matches.append({
                'home': str(r['homeTeam']).strip(), 'away': str(r['awayTeam']).strip(),
                'sh': r['scoreHome'], 'sa': r['scoreAway'],
                'ts': get_ts(r['timestamp']), 'stats': stats
            })

    if os.path.exists(DB_ARCHIVE):
        print("Extracting from historical_archive.sqlite...")
        conn = sqlite3.connect(DB_ARCHIVE)
        df = pd.read_sql_query("SELECT homeTeam, awayTeam, scoreHome, scoreAway, startTimestamp, stats_blob FROM archive_matches WHERE stats_blob IS NOT NULL", conn)
        conn.close()
        for _, r in df.iterrows():
            raw_feats = extract_features_from_json(r['stats_blob'])
            if not raw_feats: continue
            stats = {
                'Ball possession': raw_feats.get('Ball possession', (50, 50)),
                'Shots on target': raw_feats.get('Shots on target', (0, 0)),
                'Corner kicks': raw_feats.get('Corner kicks', (0, 0)),
                'Expected goals': raw_feats.get('Expected goals', (0.0, 0.0))
            }
            all_matches.append({
                'home': str(r['homeTeam']).strip(), 'away': str(r['awayTeam']).strip(),
                'sh': r['scoreHome'], 'sa': r['scoreAway'],
                'ts': get_ts(r['startTimestamp']), 'stats': stats
            })

    all_matches.sort(key=lambda x: x['ts'])
    print(f"📊 Total unified matches: {len(all_matches)}")

    team_history = {}
    sequences = []
    targets = []
    tracked_cats = ['Ball possession', 'Shots on target', 'Corner kicks', 'Expected goals']

    for m in all_matches:
        h_t, a_t = m['home'], m['away']
        h_vals = [m['stats'][c][0] for c in tracked_cats] + [m['sh']]
        a_vals = [m['stats'][c][1] for c in tracked_cats] + [m['sa']]

        if h_t not in team_history: team_history[h_t] = []
        if a_t not in team_history: team_history[a_t] = []

        if len(team_history[h_t]) >= sequence_length and len(team_history[a_t]) >= sequence_length:
            h_seq = np.array(team_history[h_t][-sequence_length:])
            a_seq = np.array(team_history[a_t][-sequence_length:])
            sequences.append(np.concatenate([h_seq, a_seq], axis=1))
            if m['sh'] > m['sa']: targets.append(2)
            elif m['sh'] == m['sa']: targets.append(1)
            else: targets.append(0)

        team_history[h_t].append(h_vals)
        team_history[a_t].append(a_vals)

    if not sequences:
        print("❌ Still zero sequences. Check team names and chronological density.")
        print(f"Unique teams tracked: {len(team_history)}")
        return

    X, y = np.array(sequences), np.array(targets)
    print(f"✅ Generated {len(X)} sequences.")

    num_s, seq_l, num_f = X.shape
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X.reshape(-1, num_f)).reshape(num_s, seq_l, num_f)

    np.save(os.path.join(OUTPUT_DIR, 'X_sequences.npy'), X_scaled)
    np.save(os.path.join(OUTPUT_DIR, 'y_targets.npy'), y)
    joblib.dump(scaler, os.path.join(OUTPUT_DIR, 'scaler.pkl'))
    print(f"💾 Saved {len(X)} samples to {OUTPUT_DIR}")

if __name__ == "__main__":
    prepare_sequential_data(sequence_length=2)
