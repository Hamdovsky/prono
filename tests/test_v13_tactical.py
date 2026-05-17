import json
import os
import sys

CORE_DIR = os.path.join(os.path.dirname(__file__), '..', 'core')
sys.path.append(CORE_DIR)

from prediction_engine import process_prediction

def test_v13():
    print("🧪 Testing Stitch V13 Total Tactical...")
    
    # Scene: Possession team vs Counter-Attack team
    test_match = {
        "homeTeam": "Manchester City",
        "awayTeam": "Tottenham",
        "league": "Premier League",
        "home_xg": 2.5,
        "away_xg": 1.2,
        "teamStats": {
            "home": {"avgPossession": 65, "avgGoalsScored": 2.2},
            "away": {"avgPossession": 40, "avgGoalsScored": 1.5, "avgShots": 14}
        },
        "news_data": {"impact": {}}
    }
    
    try:
        result = process_prediction(test_match)
        print(f"✅ V13 Engine Response: {result['ai_source']}")
        print(f"🎭 Home Style: {result['metrics']['tactical_v13']['home_style']}")
        print(f"🎭 Away Style: {result['metrics']['tactical_v13']['away_style']}")
        print(f"⚽ Final xG: {result['metrics']['raw_xg_h']} - {result['metrics']['raw_xg_a']}")
        
        for pred in result['predictions']:
            print(f"   - {pred['label']}: {pred['val']} (Color: {pred['color']})")
            
        print("\n✨ V13 Tactical logic is OPERATIONAL.")
    except Exception as e:
        print(f"❌ V13 Test FAILED: {str(e)}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test_v13()
