import sys
import os
import json

core_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'core')
sys.path.insert(0, core_dir)

from prediction_engine import process_prediction
import database

def run_diagnostics():
    print("--- 🩺 FULL SYSTEM DIAGNOSTICS ---")
    
    # 1. Database Check
    matches = database.get_matches_by_statuses(["scheduled", "live"])
    print(f"[{'PASS' if matches else 'WARN'}] Matches in DB: {len(matches)}")
    
    if not matches:
        print("No active matches found. Using mock match for pipeline test...")
        match = {
            'homeTeam': 'Arsenal',
            'awayTeam': 'Chelsea',
            'odds_home_open': 2.5,
            'odds_home': 2.0,
            'odds_draw': 3.3,
            'odds_away': 3.2,
            'home_xg': 2.1,
            'away_xg': 0.9,
            'player_ratings_home': '[{"rating": 7.8}, {"rating": 8.1}]',
            'player_ratings_away': '[{"rating": 6.5}, {"rating": 7.0}]'
        }
    else:
        match = matches[-1]
        
    print(f"\n--- ⚽ PIPELINE TEST ON MATCH: {match.get('homeTeam')} vs {match.get('awayTeam')} ---")
    
    try:
        # Run full prediction engine (which internally calls top_analyst_engine)
        result = process_prediction(match)
        print("[PASS] Engine returned result successfully.")
        
        # 2. Check Top Analyst Features
        ta_feats = result.get("top_analyst_features", {})
        if len(ta_feats) == 27:
            print(f"[PASS] Top Analyst feature count: {len(ta_feats)}")
        else:
            print(f"[FAIL] Top Analyst feature count expected 27, got: {len(ta_feats)}")
            
        # 3. Check Direct Prediction output
        dir_pred = result.get("direct_prediction", "N/A")
        if dir_pred and dir_pred != "N/A":
            print(f"[PASS] Direct Prediction String: {dir_pred}")
        else:
            print("[FAIL] Direct prediction missing.")
            
        # 4. Check main_predictions structure
        mp = result.get("main_predictions", [])
        print(f"[PASS] Main predictions formatted: {len(mp)} items")
        for p in mp:
            print(f"   -> {p.get('label')}: {p.get('val')}")
            
    except Exception as e:
        print(f"[FAIL] Pipeline error: {str(e)}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    run_diagnostics()
