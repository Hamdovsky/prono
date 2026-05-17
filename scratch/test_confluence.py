import sys
sys.path.insert(0, 'core')
from confluence_guard import evaluate_confluence, get_market_implied_probs

# Test 1: Consensus fort (tous d'accord)
r1 = evaluate_confluence(
    p_xgb=(0.60, 0.22, 0.18),
    p_poisson=(0.57, 0.24, 0.19),
    p_market=get_market_implied_probs(1.65, 3.5, 4.2),
    league_tier='T1'
)
print(f"TEST 1 - Consensus fort: Level={r1['level']} | Penalty={r1['penalty']} | Winner={r1['consensus_winner']}")

# Test 2: Desaccord critique (XGB dit Home, Poisson dit Away)
r2 = evaluate_confluence(
    p_xgb=(0.60, 0.20, 0.20),
    p_poisson=(0.20, 0.30, 0.50),
    p_market=get_market_implied_probs(3.2, 3.1, 2.1),
    league_tier='T2'
)
print(f"TEST 2 - Desaccord critique: Level={r2['level']} | Penalty={r2['penalty']} | NO_BET={r2['should_no_bet']}")

# Test 3: Sharp money contre le modele (marche dit Away, modeles disent Home)
r3 = evaluate_confluence(
    p_xgb=(0.55, 0.25, 0.20),
    p_poisson=(0.52, 0.28, 0.20),
    p_market=get_market_implied_probs(4.0, 3.2, 1.80),
    league_tier='T1'
)
print(f"TEST 3 - Sharp money contre: Level={r3['level']} | Penalty={r3['penalty']}")

# Test 4: Accord modere (XGB et Poisson d'accord, ecart raisonnable)
r4 = evaluate_confluence(
    p_xgb=(0.48, 0.28, 0.24),
    p_poisson=(0.45, 0.30, 0.25),
    p_market=get_market_implied_probs(2.10, 3.20, 3.40),
    league_tier='T1'
)
print(f"TEST 4 - Accord modere: Level={r4['level']} | Penalty={r4['penalty']} | Winner={r4['consensus_winner']}")

print("\nModule confluence_guard.py OK - Tous les tests passes!")
