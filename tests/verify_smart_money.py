import json
from prediction_engine import process_prediction

# Mock match object with a significant odds drop (Steam)
# Opening: 2.50, Current: 2.10 (16% drop)
# Poisson will likely favor Home if stats are decent, creating a Value Bet.
match_with_steam = {
    "homeTeam": "Steam United",
    "awayTeam": "Static FC",
    "odds_home": 2.10,
    "odds_home_open": 2.50,
    "home_xg": 2.0,
    "away_xg": 1.0,
    "news_impact": 0
}

print("--- Testing Smart Money Indicator ---")
result = process_prediction(match_with_steam)
print(json.dumps(result, indent=2))

# Check if the badge is present
labels = [p['label'] for p in result['predictions']]
if "🔥 SMART MONEY" in labels:
    print("\n✅ SUCCESS: '🔥 SMART MONEY' badge detected!")
else:
    print("\n❌ FAILURE: '🔥 SMART MONEY' badge missing.")
