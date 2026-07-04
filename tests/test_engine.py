import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))

import json
from prediction_engine import process_prediction

def analyze_match_pro(json_str):
    data = json.loads(json_str)
    res = process_prediction(data)
    if not res.get('success'):
        print(f"  Error: {res.get('error', 'unknown')}")
        return []
    out = [
        {"label": "Expected Score", "val": res.get('expected_score', 'N/A'), "confidence": 100},
        {"label": "Home Win Probability", "val": f"{res.get('home_win_probability', 0)*100:.1f}%", "confidence": round(res.get('xgboost_confidence', 0)*100, 1)},
        {"label": "Draw Probability", "val": f"{res.get('draw_probability', 0)*100:.1f}%", "confidence": round(res.get('xgboost_confidence', 0)*100, 1)},
        {"label": "Away Win Probability", "val": f"{res.get('away_win_probability', 0)*100:.1f}%", "confidence": round(res.get('xgboost_confidence', 0)*100, 1)},
        {"label": "Verdict", "val": res.get('verdict', 'N/A'), "confidence": int(res.get('xgboost_confidence', 0)*100)},
        {"label": "AI Source", "val": res.get('ai_source', 'N/A'), "confidence": 100},
        {"label": "Precision Bets", "val": str(len(res.get('precision_bets', []))), "confidence": 100},
    ]
    return out

stoke_data = json.dumps({'teamStats': {
    'home': {'avgGoalsScored': 1.44, 'avgGoalsConceded': 1.21, 'avgShotsOnTarget': 5.06, 'avgCorners': 4.8},
    'away': {'avgGoalsScored': 0.94, 'avgGoalsConceded': 1.59, 'avgShotsOnTarget': 3.76, 'avgCorners': 3.9}
}})
print("=== Stoke City vs Oxford ===")
r = analyze_match_pro(stoke_data)
for p in r:
    print(f"  {p['label']:15} {p['val']:30} {p['confidence']}%")

print()

masry_data = json.dumps({'teamStats': {
    'home': {'avgGoalsScored': 2.1, 'avgGoalsConceded': 0.8, 'avgShotsOnTarget': 7.2, 'avgCorners': 6.1},
    'away': {'avgGoalsScored': 0.7, 'avgGoalsConceded': 1.9, 'avgShotsOnTarget': 2.9, 'avgCorners': 3.1}
}})
print("=== Al Masry vs Modern Sport ===")
r2 = analyze_match_pro(masry_data)
for p in r2:
    print(f"  {p['label']:15} {p['val']:30} {p['confidence']}%")
