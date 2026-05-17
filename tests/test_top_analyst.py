import json
import sys
import os

# Add core to path
sys.path.append(os.path.join(os.path.dirname(os.path.dirname(__file__)), 'core'))

try:
    from top_analyst_engine import process_match_for_top_analyst
except ImportError as e:
    print(f"Error importing top_analyst_engine: {e}")
    sys.exit(1)

def run_test():
    # Simulated Match Data with clear Sharp Money and Value conditions
    test_match = {
        "homeTeam": "Arsenal",
        "awayTeam": "Liverpool",
        "odds_home_open": 2.50,
        "odds_home": 2.10, # Dropped from 2.50 to 2.10 (Sharp Money) -> >10%
        "odds_draw_open": 3.40,
        "odds_draw": 3.50,
        "odds_away_open": 2.80,
        "odds_away": 3.20,
        "home_xg": 2.1,
        "away_xg": 1.1,
        "home_sot": 6.0,
        "away_sot": 3.0,
        "home_motivation": 1.2,
        "away_motivation": 0.9,
        "news_impact": 1.5,
        "news_sentiment": 0.8
    }

    print("Running Top Analyst Engine Verification...")
    print("-" * 50)
    
    try:
        result = process_match_for_top_analyst(test_match)
        
        print("\n[DIRECT PREDICTION]")
        print(f"➡️  {result['direct_prediction']}")
        
        print("\n[ML FEATURES - XGBoost Ready]")
        features = result['ml_features']
        for k, v in features.items():
            print(f"   {k}: {v:.4f}")
            
        print("\n[INTERNAL ANALYSIS]")
        print(f"True Probs -> Home: {result['analysis_data']['odds']['true_prob_h']:.2f}, Away: {result['analysis_data']['odds']['true_prob_a']:.2f}, Draw: {result['analysis_data']['odds']['true_prob_d']:.2f}")
        print(f"Sharp Money HG: {result['analysis_data']['odds']['sharp_money_h']} | AG: {result['analysis_data']['odds']['sharp_money_a']}")
        print(f"Expected Goals Total: {result['analysis_data']['ou_cs']['expected_total_goals']:.2f} | Over 2.5 Prob: {result['analysis_data']['ou_cs']['over_25_prob']:.2f}")
        print(f"Asian Handicap Strongest: {result['analysis_data']['ah']['ah_strongest_team']} | Recommended Line: {result['analysis_data']['ah']['ah_suggested_line']}")
        print(f"Value Bet Detected: {result['analysis_data']['value']['value_bet_flag']} | Best Pick: {result['analysis_data']['value']['best_value_selection']}")
        
        # Validation checks
        assert type(result['direct_prediction']) == str, "Direct prediction must be a string."
        assert "%" not in result['direct_prediction'], "Prediction should not contain percentages (%)."
        
        for k, v in features.items():
            assert type(v) == float or type(v) == int, f"Feature {k} must be numerical, got {type(v)}"
            
        print("\n✅ All Tests Passed!")
        
    except Exception as e:
        print(f"\n❌ Test Failed: {e}")

if __name__ == "__main__":
    run_test()
