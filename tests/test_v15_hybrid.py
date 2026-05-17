import json
import sys
import os

# Add core to path
sys.path.append(os.path.join(os.getcwd(), 'core'))

from prediction_engine import process_prediction

# Sample match with stats for DNN
test_match = {
    "homeTeam": "Real Madrid",
    "awayTeam": "Barcelona",
    "league": "La Liga",
    "scoreHome": None,
    "scoreAway": None,
    "status": "PRE",
    "startTimestamp": 1741720000,
    "possession_home": 55,
    "possession_away": 45,
    "shots_on_target_home": 7,
    "shots_on_target_away": 3,
    "corners_home": 6,
    "corners_away": 4,
    "home_xg": 2.1,
    "away_xg": 1.2
}

print("🧪 Testing V15 Deep Prime Hybrid Integration...")
res = process_prediction(test_match)

if res['success']:
    print(f"✅ AI Source: {res['ai_source']}")
    print(f"📊 Predictions:")
    for p in res['predictions']:
        print(f"  - {p['label']}: {p['val']} ({p['color']})")
    
    print(f"\n🧬 Metrics:")
    print(f"  - Win Prob (H/D/A): {res['metrics']['home_win_probability']}% / {res['metrics']['draw_probability']}% / {res['metrics']['away_win_probability']}%")
    print(f"  - Expected Score: {res['metrics']['expected_score']}")
else:
    print(f"❌ Error: {res.get('error')}")
