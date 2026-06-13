import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from core.goal_model import (
    predict_btts, predict_ou, eCMP, lambdaCMP, pCMP,
    predict_hurdle, apply_offset
)

def test_btts():
    btts = predict_btts(1.5, 1.2, rho=-0.12)
    assert 0 < btts < 1, f"BTTS should be 0-1, got {btts}"
    print(f"  OK BTTS(1.5,1.2)={btts:.4f}")

def test_ou():
    ou25 = predict_ou(1.5, 1.2, threshold=2.5, rho=-0.12)
    ou15 = predict_ou(1.5, 1.2, threshold=1.5, rho=-0.12)
    ou35 = predict_ou(1.5, 1.2, threshold=3.5, rho=-0.12)
    assert ou15 >= ou25 >= ou35, f"O1.5({ou15}) >= O2.5({ou25}) >= O3.5({ou35})"
    print(f"  OK O/U: 1.5={ou15:.4f} 2.5={ou25:.4f} 3.5={ou35:.4f}")

def test_btts_gamma():
    btts0 = predict_btts(1.5, 1.2, rho=-0.12, gamma=0.0)
    btts1 = predict_btts(1.5, 1.2, rho=-0.12, gamma=0.2)
    print(f"  OK BTTS gamma=0: {btts0:.4f} gamma=0.2: {btts1:.4f}")

def test_ecmp():
    e = eCMP(1.5, 1.0)
    assert e > 0, f"eCMP should be > 0, got {e}"
    print(f"  OK eCMP(1.5,1.0)={e:.4f}")

def test_lambdaCMP():
    lam = lambdaCMP(1.5, 1.0)
    assert lam > 0, f"lambdaCMP should be > 0, got {lam}"
    # eCMP(lambdaCMP(mu), nu) should be close to mu
    e = eCMP(lam, 1.0)
    assert abs(e - 1.5) < 0.1, f"eCMP(lambdaCMP(1.5))={e}, expected ~1.5"
    print(f"  OK lambdaCMP(1.5,1.0)={lam:.4f} -> eCMP={e:.4f}")

def test_pCMP():
    p = pCMP(1.5, 1.0, 2)
    assert 0 < p < 1, f"pCMP should be 0-1, got {p}"
    p_tail = pCMP(1.5, 1.0, 2, lower_tail=False)
    assert abs(p + p_tail - 1.0) < 0.02, f"CDF({p}) + tail({p_tail}) should sum to ~1"
    print(f"  OK pCMP(1.5,1.0,2) P(X<=2)={p:.4f} P(X>2)={p_tail:.4f}")

def test_hurdle():
    hurdle = predict_hurdle(1.5, 1.2, pi0=0.08, rho=-0.12)
    total = hurdle["p_home"] + hurdle["p_draw"] + hurdle["p_away"]
    assert abs(total - 1.0) < 0.001, f"Hurdle probs sum to {total}, expected 1.0"
    assert 0 < hurdle["p_00"] < 1, f"p_00 should be 0-1, got {hurdle['p_00']}"
    print(f"  OK Hurdle: home={hurdle['p_home']:.4f} draw={hurdle['p_draw']:.4f} away={hurdle['p_away']:.4f} p00={hurdle['p_00']:.4f}")

def test_offset():
    xg_h, xg_a = apply_offset(1.5, 1.2, offset_minutes=120, standard_minutes=90)
    assert abs(xg_h - 2.0) < 0.01, f"120min xg_h should be 2.0, got {xg_h}"
    assert abs(xg_a - 1.6) < 0.01, f"120min xg_a should be 1.6, got {xg_a}"
    xg_h2, xg_a2 = apply_offset(1.5, 1.2, offset_minutes=45, standard_minutes=90)
    assert abs(xg_h2 - 0.75) < 0.01, f"45min xg_h should be 0.75, got {xg_h2}"
    print(f"  OK Offset: 120min->({xg_h:.2f},{xg_a:.2f}) 45min->({xg_h2:.2f},{xg_a2:.2f})")

def test_monte_carlo_goalmodel_gamma():
    from core.goal_model import monte_carlo_simulation_goalmodel
    sim0 = monte_carlo_simulation_goalmodel(1.5, 1.2, rho=-0.12, gamma=0.0, iterations=5000)
    sim1 = monte_carlo_simulation_goalmodel(1.5, 1.2, rho=-0.12, gamma=0.2, iterations=5000)
    total0 = sim0['p_h'] + sim0['p_d'] + sim0['p_a']
    total1 = sim1['p_h'] + sim1['p_d'] + sim1['p_a']
    assert abs(total0 - 1.0) < 0.01
    assert abs(total1 - 1.0) < 0.01
    print(f"  OK MC gamma=0: H={sim0['p_h']:.3f} D={sim0['p_d']:.3f} A={sim0['p_a']:.3f}")
    print(f"  OK MC gamma=0.2: H={sim1['p_h']:.3f} D={sim1['p_d']:.3f} A={sim1['p_a']:.3f}")

if __name__ == "__main__":
    tests = [
        test_btts, test_ou, test_btts_gamma,
        test_ecmp, test_lambdaCMP, test_pCMP,
        test_hurdle, test_offset, test_monte_carlo_goalmodel_gamma
    ]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as e:
            failed += 1
            print(f"  FAIL {t.__name__}: {e}")
    print(f"\n{'='*40}")
    print(f"  {passed} passed, {failed} failed out of {len(tests)}")
    sys.exit(0 if failed == 0 else 1)
