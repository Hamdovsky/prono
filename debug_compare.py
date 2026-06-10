import sys, os, json, sqlite3, time
sys.path.insert(0, os.path.join('core'))
sys.path.insert(0, os.path.join('scripts'))

from prediction_engine import process_prediction
from ml_features import extract_ml_features, FEATURE_NAMES_TITANIUM
import xgboost as xgb, numpy as np

bst = xgb.Booster()
bst.load_model('models/titanium_v2.json')

conn = sqlite3.connect('data/historical_archive.sqlite')
conn.row_factory = sqlite3.Row
cur = conn.cursor()
cur.execute('SELECT * FROM archive_matches WHERE scoreHome IS NOT NULL AND stats_blob IS NOT NULL ORDER BY RANDOM() LIMIT 20')
rows = [dict(r) for r in cur.fetchall()]
conn.close()

def build_match_payload(row):
    feats = {}
    try: stats = json.loads(row.get('stats_blob', '[]'))
    except: stats = []
    h2h = row.get('h2h_data')
    if isinstance(h2h, str):
        try: h2h = json.loads(h2h)
        except: h2h = None
    odds = row.get('odds_movement_24h')
    if isinstance(odds, str):
        try: odds = json.loads(odds)
        except: odds = None
    return {
        'id': row.get('sofascore_id') or row.get('id'),
        'homeTeam': row.get('homeTeam', 'Unknown'),
        'awayTeam': row.get('awayTeam', 'Unknown'),
        'league': row.get('tournament_name', 'Unknown'),
        'odds_home': feats.get('odds_h', 2.0),
        'odds_draw': 3.0,
        'odds_away': feats.get('odds_a', 3.0),
        'home_xg': row.get('home_xg', 0) or 0,
        'away_xg': row.get('away_xg', 0) or 0,
        'stats': stats,
        'h2h_data': h2h,
        'odds_movement_24h': odds,
        'startTimestamp': row.get('startTimestamp')
    }

for row in rows:
    hscore = int(row.get('scoreHome', 0))
    ascore = int(row.get('scoreAway', 0))
    actual = 2 if hscore > ascore else 1 if hscore == ascore else 0
    actual_label = ['AWAY','DRAW','HOME'][actual]
    
    # Raw model prediction
    feats = extract_ml_features(dict(row), fetch_history=True)
    vector = np.array([[float(feats.get(f, 0)) for f in FEATURE_NAMES_TITANIUM]])
    dmat = xgb.DMatrix(vector, feature_names=FEATURE_NAMES_TITANIUM)
    raw_preds = bst.predict(dmat)[0]
    raw_verdict = ['AWAY','DRAW','HOME'][np.argmax(raw_preds)]
    raw_correct = raw_verdict == actual_label
    
    # Full pipeline prediction
    match = build_match_payload(row)
    try:
        pred = process_prediction(match)
    except Exception as e:
        print(f'[FAIL] {row["homeTeam"]} vs {row["awayTeam"]}: {e}')
        continue
    
    if not pred.get('success', False):
        print(f'[SKIP] {row["homeTeam"]} vs {row["awayTeam"]}: {pred.get("error")}')
        continue
    
    p_h = pred.get('home_win_probability', pred.get('p_h', 0))
    p_d = pred.get('draw_probability', pred.get('p_d', 0))
    p_a = pred.get('away_win_probability', pred.get('p_a', 0))
    pipe_verdict = 'HOME' if p_h >= max(p_d, p_a) else 'DRAW' if p_d >= max(p_h, p_a) else 'AWAY'
    pipe_correct = pipe_verdict == actual_label
    
    match_str = f'{row["homeTeam"]:30s} vs {row["awayTeam"]:30s}'
    status = 'OK' if raw_correct == pipe_correct else 'CHANGED'
    if raw_correct != pipe_correct or not raw_correct:
        print(f'[{status}] {actual_label} RAW={raw_verdict} RAW_PROBS={raw_preds[0]:.3f}/{raw_preds[1]:.3f}/{raw_preds[2]:.3f} PIPE={pipe_verdict} PIPE_PROBS={p_h:.3f}/{p_d:.3f}/{p_a:.3f}')
