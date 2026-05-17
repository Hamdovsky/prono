import sys
import os

# Append core directory to path to import modules
core_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'core')
sys.path.append(core_path)

from prediction_engine import calculate_dmf_hafiz, calculate_xg_perf_delta, impute_missing_match_data

def test_v50_models():
    print("🚀 [TEST_V50_V2.PY] Executing Advanced V50+ Mathematical Model Tests...")
    
    # --- TEST 1: Hafiz DMF Model ---
    print("\n--- TEST 1: Hafiz DMF Model (Dynamic Motivation Factor) ---")
    # Title Contender: Weight 1.5, 2 points behind, 5 matches left, 33 matches played
    title_dmf = calculate_dmf_hafiz(target_weight=1.5, distance_target=2.0, matches_rem=5, matches_played=33, is_dead_zone=False)
    # Dead Zone Team: Weight 0.0, 15 points behind Europe, 33 matches played
    dead_zone_dmf = calculate_dmf_hafiz(target_weight=0.0, distance_target=15.0, matches_rem=5, matches_played=33, is_dead_zone=True)
    # Title Contender Far Behind: Weight 1.5, 9 points behind, 5 matches left - pressure should fade
    far_behind_dmf = calculate_dmf_hafiz(target_weight=1.5, distance_target=9.0, matches_rem=5, matches_played=33, is_dead_zone=False)
    
    print(f"✅ Title Contender (Tightly contested): {title_dmf}")
    print(f"✅ Title Contender (Far behind, fading pressure): {far_behind_dmf}")
    print(f"✅ Dead Zone Team (Penalized): {dead_zone_dmf}")
    
    assert title_dmf > far_behind_dmf > dead_zone_dmf, "Hafiz DMF math is illogical."

    # --- TEST 2: xG-Elo Performance Deltas ---
    print("\n--- TEST 2: xG-Elo Quality of Play (QoP) Deltas ---")
    mock_history_unlucky = [
        {"h_xg": 2.5, "a_xg": 0.5, "score_for": 1, "score_against": 1}, # Under-rewarded (xG diff: +2.0, Score diff: 0, Delta: +2.0)
    ]
    mock_history_lucky = [
        {"h_xg": 1.0, "a_xg": 3.0, "score_for": 2, "score_against": 0}, # Over-rewarded (xG diff: -2.0, Score diff: +2, Delta: -4.0)
    ]
    
    delta_unlucky = calculate_xg_perf_delta(mock_history_unlucky, is_home=True)
    delta_lucky = calculate_xg_perf_delta(mock_history_lucky, is_home=True)
    
    print(f"✅ Unlucky Team (Deserved to win, drew): {delta_unlucky:+.2f} (Should be positive)")
    print(f"✅ Lucky Team (Deserved to lose heavily, won): {delta_lucky:+.2f} (Should be highly negative)")
    
    assert delta_unlucky > 0, "Unlucky teams should receive a positive QoP delta to boost their future xG."
    assert delta_lucky < 0, "Lucky teams should receive a negative QoP delta to penalize their future xG."

    # --- TEST 3: Zero-Crash Imputation Protocol ---
    print("\n--- TEST 3: Smart Missing Data Imputation ---")
    mock_features = {"rest_h": 0, "rest_a": 0, "travel_f": 0}
    mock_match = {"is_international": True, "homeTeam": "Manchester City", "awayTeam": "Real Madrid"}
    
    imputed = impute_missing_match_data(mock_features, mock_match)
    print(f"✅ Imputed Rest H -> {imputed.get('rest_h')} days")
    print(f"✅ Imputed Rest A -> {imputed.get('rest_a')} days")
    print(f"✅ Imputed Intl Travel F -> {imputed.get('travel_f')} multiplier")
    print(f"✅ Data Completeness -> {imputed.get('data_completeness')}%")
    
    assert imputed.get('rest_h') == 7.0, "Rest was not imputed to 7 days."
    assert imputed.get('travel_f') == 2.5, "International travel was not imputed."
    
    print("\n🏆 All Python Engine V50+ Mathematical Models verified successfully.")

if __name__ == "__main__":
    test_v50_models()
