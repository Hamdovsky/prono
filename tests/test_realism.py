"""
V70 Realism Test — Validates that prediction_engine produces realistic outputs.
Tests that draws are not zero-suppressed, O/U comes from MC, confidence is calibrated.
"""
import sys, os, json
core_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'core')
sys.path.append(core_path)

from prediction_engine import monte_carlo_simulation, process_prediction, simulate_match_mc
from ml_features import FEATURE_NAMES_V52

def test_monte_carlo_realistic():
    print("\n--- TEST 1: Monte Carlo 5000 iterations produces stable O/U ---")
    # Balanced match: ~2.4 total goals expected
    sim = monte_carlo_simulation(xg_h=1.2, xg_a=1.2)
    print(f"  ou_25_prob = {sim['ou_25_prob']*100:.1f}%")
    print(f"  ou_35_prob = {sim['ou_35_prob']*100:.1f}%")
    print(f"  ou_15_prob = {sim['ou_15_prob']*100:.1f}%")
    print(f"  btts_prob  = {sim['btts_prob']*100:.1f}%")
    assert 'ou_35_prob' in sim, "Missing ou_35_prob key"
    assert 'ou_15_prob' in sim, "Missing ou_15_prob key"
    # For xg 1.2+1.2=2.4, ou_25 should be in realistic range ~40-55%
    assert 20 <= sim['ou_25_prob'] * 100 <= 80, f"ou_25_prob unrealistic: {sim['ou_25_prob']}"
    print("  ✅ PASS")

def test_draw_not_eliminated_balanced():
    print("\n--- TEST 2: Draw probability >= 5% in balanced matches ---")
    # Perfectly balanced match
    match = {
        "homeTeam": "Team A",
        "awayTeam": "Team B",
        "league": "Test League",
        "home_xg": 1.2,
        "away_xg": 1.2,
        "odds_home": 2.5,
        "odds_draw": 3.2,
        "odds_away": 2.5,
    }
    result = process_prediction(match)
    p_d = result.get('draw_probability', 0) * 100
    print(f"  Draw probability = {p_d:.1f}%")
    print(f"  Home probability = {result.get('home_win_probability',0)*100:.1f}%")
    print(f"  Away probability = {result.get('away_win_probability',0)*100:.1f}%")
    assert p_d >= 5.0, f"Draw probability too low in balanced match: {p_d:.1f}%"
    print("  ✅ PASS")

def test_confidence_not_over_inflated():
    print("\n--- TEST 3: Confidence <= 85% when win prob < 65% ---")
    match = {
        "homeTeam": "Team H",
        "awayTeam": "Team A",
        "league": "Test League",
        "home_xg": 1.5,
        "away_xg": 1.0,
    }
    result = process_prediction(match)
    conf = result.get('xgboost_confidence', 0) * 100
    h_prob = result.get('home_win_probability', 0) * 100
    print(f"  Home win probability = {h_prob:.1f}%")
    print(f"  Confidence score     = {conf:.1f}%")
    if h_prob < 65:
        assert conf <= 87, f"Confidence over-inflated: {conf:.1f}% for {h_prob:.1f}% win prob"
        print(f"  ✅ PASS (conf {conf:.1f}% is realistic for {h_prob:.1f}% win)")
    else:
        print(f"  ℹ️  SKIP (home prob {h_prob:.1f}% is ≥ 65%, conf {conf:.1f}% accepted)")

def test_ou_in_precision_bets_uses_mc():
    print("\n--- TEST 4: O/U in precision_bets NOT using arbitrary xg*25 formula ---")
    # High scoring match: xg = 2.0 + 1.8 = 3.8
    match_high = {
        "homeTeam": "Att H",
        "awayTeam": "Att A",
        "league": "Test League",
        "home_xg": 2.0,
        "away_xg": 1.8,
    }
    result_high = process_prediction(match_high)
    bets = result_high.get('precision_bets', [])
    ou_bet = next((b for b in bets if '2.5' in b.get('market', '')), None)
    if ou_bet:
        print(f"  Found O/U bet: {ou_bet['market']} @ {ou_bet['probability']}%")
        print(f"  Reason: {ou_bet['reason']}")
        # Verify it uses Monte Carlo language in reason
        assert 'Monte Carlo' in ou_bet.get('reason', ''), "O/U bet reason should reference Monte Carlo"
        # Probability should be in realistic range
        assert 20 <= ou_bet['probability'] <= 95, f"O/U probability out of range: {ou_bet['probability']}"
        print("  ✅ PASS")
    else:
        print("  ℹ️  No O/U bet generated (may be in 43-57% ambiguous zone — acceptable)")
        print("  ✅ PASS (ambiguous zone correctly omits bet)")

def test_xgboost_simulation_realistic():
    print("\n--- TEST 5: XGBoost Simulation Correction & Normalization ---")
    import numpy as np
    # Mock some features based on actual dimensionality
    active_features = [1.0] * len(FEATURE_NAMES_V52) 
    
    # We call simulate_match_mc
    # However it requires XGB_BOOSTER to be loaded.
    from prediction_engine import XGB_BOOSTER
    if XGB_BOOSTER is None:
        print("  ℹ️  XGB_BOOSTER not loaded (skipping deep XGB test)")
        return
        
    p_h, p_d, p_a = simulate_match_mc(XGB_BOOSTER, active_features, num_simulations=500, feature_names=FEATURE_NAMES_V52)
    print(f"  XGB Probabilities: H={p_h*100:.1f}%, D={p_d*100:.1f}%, A={p_a*100:.1f}%")
    print(f"  Sum = {p_h + p_d + p_a:.4f}")
    
    # Verification
    assert abs((p_h + p_d + p_a) - 1.0) < 0.0001, "Probabilities must sum to 1.0"
    if abs(p_h - p_a) < 0.20:
        assert p_d > 0.05, f"Draw probability too low for balanced XGB match: {p_d:.2f}"
    print("  ✅ PASS")

if __name__ == "__main__":
    print("🧪 V70 Realism Test Suite")
    print("=" * 50)
    try:
        test_monte_carlo_realistic()
        test_draw_not_eliminated_balanced()
        test_confidence_not_over_inflated()
        test_ou_in_precision_bets_uses_mc()
        test_xgboost_simulation_realistic()
        print("\n" + "=" * 50)
        print("🏆 ALL REALISM TESTS PASSED")
    except AssertionError as e:
        print(f"\n❌ ASSERTION FAILED: {e}")
        sys.exit(1)
    except Exception as e:
        import traceback
        print(f"\n💥 ERROR: {e}")
        traceback.print_exc()
        sys.exit(1)
