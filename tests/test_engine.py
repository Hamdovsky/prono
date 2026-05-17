from prediction_engine import analyze_match_pro
import json

# Simulate Stoke City vs Oxford with real teamStats
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
