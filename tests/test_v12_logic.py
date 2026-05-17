import json
import os
import sys

# Standard paths
CORE_DIR = os.path.join(os.path.dirname(__file__), '..', 'core')
sys.path.append(CORE_DIR)

from prediction_engine import process_prediction

def test_v12():
    print("🧪 Testing Stitch V12 Scientific Fusion...")
    
    test_match = {
        "homeTeam": "Real Madrid",
        "awayTeam": "Barcelona",
        "league": "La Liga",
        "home_xg": 2.1,
        "away_xg": 1.8,
        "news_data": {
            "impact": {
                "home_att": 0.9,  # Missing a star striker
                "away_def": 1.2   # Defense is weak
            }
        }
    }
    
    try:
        result = process_prediction(test_match)
        print(f"✅ V12 Engine Response: {result['ai_source']}")
        print(f"📊 Home Win Prob: {result['metrics']['home_win_probability']}%")
        print(f"⚽ Expected Score: {result['metrics']['expected_score']}")
        
        for pred in result['predictions']:
            print(f"   - {pred['label']}: {pred['val']}")
            
        print("\n✨ V12 logic seems STABLE and functional.")
    except Exception as e:
        print(f"❌ V12 Test FAILED: {str(e)}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test_v12()
