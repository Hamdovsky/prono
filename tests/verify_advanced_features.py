import json
from prediction_engine import process_prediction
import os

# 1. Test Case: STAR PLAYER OUT (Significant Impact)
match_absences = {
    "homeTeam": "Injured City",
    "awayTeam": "Full Squad",
    "home_xg": 2.0,
    "away_xg": 1.0,
    "news_data": {
        "impact": {
            "home_att": 0.70, # 30% attack drop
            "home_def": 1.10, # 10% defense weakness
            "away_att": 1.0,
            "away_def": 1.0
        }
    }
}

print("\n--- Testing Absence Impact ---")
res1 = process_prediction(match_absences)
labels1 = [p['label'] for p in res1['predictions']]
print(f"Abilities: {res1['metrics']['raw_xg_h']} xG Home (adjusted from 2.0)")
if "🚑 ABSENCES" in labels1:
    print("✅ SUCCESS: '🚑 ABSENCES' badge detected!")
else:
    print("❌ FAILURE: '🚑 ABSENCES' badge missing.")


# 2. Test Case: GAP LEARNING (Correction based on log)
# We need to mock a failure trend in the log first
os.makedirs('data', exist_ok=True)
mock_log = {
    "Broken League": [
        {"vote_was_misleading": True},
        {"vote_was_misleading": True},
        {"vote_was_misleading": True}
    ]
}
with open('data/accuracy_log.json', 'w', encoding='utf-8') as f:
    json.dump(mock_log, f)

match_gap = {
    "homeTeam": "Losing Home",
    "awayTeam": "Winning Away",
    "league": "Broken League",
    "home_xg": 2.0,
    "away_xg": 1.0
}

print("\n--- Testing Gap Learning ---")
res2 = process_prediction(match_gap)
labels2 = [p['label'] for p in res2['predictions']]
if "📉 GAP LEARNING" in labels2:
    print("✅ SUCCESS: '📉 GAP LEARNING' badge detected!")
else:
    print("❌ FAILURE: '📉 GAP LEARNING' badge missing.")
