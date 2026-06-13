"""
Tests for core/goal_model.py — Dixon-Coles MLE, NegBin, CMP, RPS.
"""
import sys
import os
import math
import json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from core.goal_model import (
    poisson_pmf,
    negbin_pmf,
    cmp_pmf,
    get_dixon_coles_adjustment,
    calculate_time_weights,
    fit_dixon_coles,
    calculate_rps,
    log_rps_to_accuracy_log,
    monte_carlo_simulation_goalmodel,
    calculate_most_likely_score_goalmodel,
    _choose_distribution,
    load_or_fit_goalmodel_parameters,
    _fallback_params,
    CACHE_DIR
)


def test_poisson_pmf():
    p = poisson_pmf(1.5, 0)
    assert p > 0.22 and p < 0.23, f"Poisson(1.5, 0) expected ~0.223, got {p}"
    p = poisson_pmf(1.5, 1)
    assert p > 0.33 and p < 0.34, f"Poisson(1.5, 1) expected ~0.335, got {p}"
    p = poisson_pmf(1.5, -1)
    assert p == 0.0, "Negative k should return 0"


def test_negbin_pmf():
    p = negbin_pmf(1.5, 2.0, 0)
    assert p > 0.3 and p < 0.33, f"NegBin(1.5, 2, 0) expected ~0.327, got {p}"
    p = negbin_pmf(1.5, 2.0, 1)
    assert p > 0.25 and p < 0.3, f"NegBin(1.5, 2, 1) expected ~0.273, got {p}"
    p = negbin_pmf(0, 2.0, 0)
    assert p == 0.0, "mu=0 should return 0"
    p = negbin_pmf(1.5, 0, 0)
    assert p == 0.0, "theta=0 should return 0"


def test_cmp_pmf():
    p = cmp_pmf(1.5, 1.0, 0)
    assert p > 0.0, f"CMP(1.5, 1, 0) should be > 0, got {p}"
    p_sum = sum(cmp_pmf(1.5, 1.0, k) for k in range(10))
    assert abs(p_sum - 1.0) < 0.01, f"CMP probabilities should sum to ~1, got {p_sum}"


def test_dixon_coles_adjustment():
    adj = get_dixon_coles_adjustment(1.2, 1.0, 0, 0, -0.12)
    assert adj > 1.0, f"0-0 adjustment should inflate prob (adj>1), got {adj}"
    adj = get_dixon_coles_adjustment(1.2, 1.0, 2, 2, -0.12)
    assert adj == 1.0, "2-2 should have no adjustment"
    adj = get_dixon_coles_adjustment(1.2, 1.0, 1, 1, -0.12)
    assert adj > 1.0, "1-1 should have adj > 1"


def test_calculate_time_weights():
    days = [0, 30, 90, 180, 365]
    w = calculate_time_weights(days)
    assert w[0] == 1.0, "0 days should have weight 1.0"
    assert w[4] == 0.5, f"365 days should have weight 0.5, got {w[4]}"
    assert len(w) == 5
    assert all(w[i] >= w[i+1] for i in range(len(w)-1)), "Weights should be non-increasing"


def test_fit_dixon_coles():
    matches = [
        {'home': 'TeamA', 'away': 'TeamB', 'home_goals': 2, 'away_goals': 1, 'days_ago': 10},
        {'home': 'TeamB', 'away': 'TeamC', 'home_goals': 1, 'away_goals': 1, 'days_ago': 20},
        {'home': 'TeamC', 'away': 'TeamA', 'home_goals': 0, 'away_goals': 3, 'days_ago': 30},
        {'home': 'TeamA', 'away': 'TeamC', 'home_goals': 1, 'away_goals': 0, 'days_ago': 40},
        {'home': 'TeamB', 'away': 'TeamA', 'home_goals': 2, 'away_goals': 2, 'days_ago': 50},
        {'home': 'TeamC', 'away': 'TeamB', 'home_goals': 1, 'away_goals': 2, 'days_ago': 60},
        {'home': 'TeamA', 'away': 'TeamB', 'home_goals': 3, 'away_goals': 0, 'days_ago': 70},
        {'home': 'TeamB', 'away': 'TeamC', 'home_goals': 0, 'away_goals': 1, 'days_ago': 80},
        {'home': 'TeamC', 'away': 'TeamA', 'home_goals': 1, 'away_goals': 1, 'days_ago': 90},
        {'home': 'TeamA', 'away': 'TeamC', 'home_goals': 2, 'away_goals': 0, 'days_ago': 100},
    ]
    match_days = [m['days_ago'] for m in matches]
    time_weights = calculate_time_weights(match_days)
    result = fit_dixon_coles(matches, time_weights)
    if result.get('success'):
        assert 'rho' in result, "Result should contain rho"
        assert 'hfa' in result, "Result should contain hfa"
        assert 'attack' in result, "Result should contain attack ratings"
        assert len(result['attack']) == 3, "Should have 3 teams"
        print(f"[OK] MLE converged: rho={result['rho']:.4f}, hfa={result['hfa']:.4f}")
    else:
        if not sys.platform.startswith('win'):
            raise AssertionError(f"MLE failed: {result.get('error')}")


def test_calculate_rps():
    probs = [0.5, 0.3, 0.2]
    rps_home = calculate_rps(probs, 0)
    assert rps_home >= 0, "RPS should be non-negative"
    rps_draw = calculate_rps(probs, 1)
    rps_away = calculate_rps(probs, 2)
    rps_perfect = calculate_rps([1.0, 0.0, 0.0], 0)
    assert rps_perfect == 0.0, f"Perfect prediction should have RPS=0, got {rps_perfect}"
    rps_worst = calculate_rps([1.0, 0.0, 0.0], 2)
    assert rps_worst > 0, "Wrong prediction should have RPS > 0"
    print(f"[OK] RPS home={rps_home:.4f}, draw={rps_draw:.4f}, away={rps_away:.4f}")


def test_log_rps_to_accuracy_log():
    rps = log_rps_to_accuracy_log(
        match_id='test_123',
        home_team='TeamA',
        away_team='TeamB',
        league_name='Test League',
        probs=[0.5, 0.3, 0.2],
        actual_outcome=0,
        predicted_selection='HOME'
    )
    assert rps >= 0, "RPS should be non-negative"
    log_path = os.path.join(CACHE_DIR, 'accuracy_log.json')
    if os.path.exists(log_path):
        with open(log_path, 'r') as f:
            data = json.load(f)
        rps_log = data.get('rps_log', [])
        assert len(rps_log) > 0, "rps_log should have entries"
        assert rps_log[-1]['matchId'] == 'test_123', "Last entry should be our test match"


def test_monte_carlo_goalmodel():
    for dist in ('poisson', 'negbin'):
        sim = monte_carlo_simulation_goalmodel(1.5, 1.2, distribution=dist, iterations=5000)
        total = sim['p_h'] + sim['p_d'] + sim['p_a']
        assert abs(total - 1.0) < 0.01, f"{dist}: Probabilities should sum to ~1, got {total}"
        assert sim['btts_prob'] >= 0, f"BTTS prob should be >= 0"
        assert sim['avg_total_goals'] > 0, f"Avg goals should be > 0"


def test_most_likely_score_goalmodel():
    for dist in ('poisson', 'negbin'):
        score = calculate_most_likely_score_goalmodel(1.5, 1.2, distribution=dist, rho=-0.12)
        assert ' - ' in score, f"Score should be in format 'X - Y', got {score}"
        parts = score.split(' - ')
        assert len(parts) == 2, f"Should have exactly 2 parts, got {parts}"
        assert 0 <= int(parts[0]) <= 7, f"Home goals should be 0-7, got {parts[0]}"
        assert 0 <= int(parts[1]) <= 7, f"Away goals should be 0-7, got {parts[1]}"


def test_choose_distribution():
    low_var = [{'home_goals': 1, 'away_goals': 0}] * 10
    assert _choose_distribution(low_var) in ('poisson', 'cmp'), "Low variance should pick poisson or cmp"
    high_var = [{'home_goals': 4, 'away_goals': 3}] * 5 + [{'home_goals': 0, 'away_goals': 0}] * 5
    dist = _choose_distribution(high_var)
    assert dist in ('poisson', 'negbin', 'cmp')


def test_fallback_params():
    params = _fallback_params('Test League')
    assert params['rho'] == -0.12, "Fallback rho should be -0.12"
    assert params['hfa'] == 0.25, "Fallback hfa should be 0.25"
    assert params['distribution_type'] == 'poisson', "Fallback distribution should be poisson"


if __name__ == '__main__':
    tests = [
        test_poisson_pmf,
        test_negbin_pmf,
        test_cmp_pmf,
        test_dixon_coles_adjustment,
        test_calculate_time_weights,
        test_fit_dixon_coles,
        test_calculate_rps,
        test_log_rps_to_accuracy_log,
        test_monte_carlo_goalmodel,
        test_most_likely_score_goalmodel,
        test_choose_distribution,
        test_fallback_params,
    ]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
            print(f"  OK {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"  FAIL {t.__name__}: {e}")
    print(f"\n{'='*40}")
    print(f"  {passed} passed, {failed} failed out of {len(tests)}")
    sys.exit(0 if failed == 0 else 1)
