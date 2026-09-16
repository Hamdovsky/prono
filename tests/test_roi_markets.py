"""
Tests de la boucle ROI O/U (E38) : devigeage, choix de cote, simulation 1u,
walk-forward chronologique. Deterministe (aucun acces DB).
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.roi_markets import (
    brier_score,
    choose_over_under,
    devig_two,
    simulate_roi,
    walkforward_ou_roi,
)


def _mkrows(n, goals=3, odds_over=1.95, odds_under=1.95, league="E0"):
    return [
        {
            "date": f"2025-{i % 12 + 1:02d}-{i % 27 + 1:02d}",
            "total_xg": 3.2,
            "line": 2.5,
            "goals": goals,
            "odds_over": odds_over,
            "odds_under": odds_under,
            "league": league,
        }
        for i in range(n)
    ]


def test_devig_two_symmetric():
    p_over, p_under = devig_two(2.0, 2.0)
    assert (round(p_over, 6), round(p_under, 6)) == (0.5, 0.5)


def test_devig_two_margin_free():
    p_over, p_under = devig_two(3.0, 1.5)
    assert abs(p_over - 1.0 / 3.0) < 1e-6
    assert abs(p_over + p_under - 1.0) < 1e-9


def test_devig_two_invalid():
    assert devig_two(None, 1.5) is None
    assert devig_two(1.0, 1.5) is None
    assert devig_two(0.5, 1.5) is None


def test_brier_bounds():
    assert 0.0 <= brier_score(0.3, 0) <= 1.0
    assert brier_score(0.7, 1) < brier_score(0.3, 1)


def test_choose_over_under():
    assert choose_over_under(0.7, 0.5) == "over"
    assert choose_over_under(0.3, 0.5) == "under"
    assert choose_over_under(0.5, 0.5) is None  # edge nul -> aucun pari
    assert choose_over_under(0.52, 0.5, min_edge=0.05) is None


def test_simulate_roi_empty():
    s = simulate_roi([])
    assert s["n"] == 0 and s["roi"] is None


def test_simulate_roi_all_won():
    picks = [{"side": "over", "odds": 2.0, "won": True}] * 3
    s = simulate_roi(picks)
    assert s["n"] == 3 and s["roi"] == 1.0 and s["hit"] == 1.0


def test_simulate_roi_loss():
    picks = [{"side": "over", "odds": 2.0, "won": False}]
    s = simulate_roi(picks)
    assert s["roi"] == -1.0


def test_walkforward_requires_min_samples():
    # Garde = MIN_ROWS (300) ; 296 < 300 -> refus (evite tout verdict fantome)
    assert walkforward_ou_roi(_mkrows(296)) is None


def test_walkforward_favors_over_when_model_edge():
    # 600 matchs tous Over (goals=3 > line 2.5), cote devigue ~0.5/0.5,
    # modele P(over|mu=3.2) ~0.59 -> edge over -> mise sur Over -> gagne -> ROI>0
    # NB: folds=4 -> seuls 3/4 (450 rows) sont evalues (folds 1..3), derniers 150 jamais testes
    res = walkforward_ou_roi(_mkrows(600), min_edge=0.02)
    assert res is not None
    assert res["stats"]["n"] == 450
    assert res["stats"]["roi"] > 0.5
    assert res["brier_model"] is not None and res["brier_market"] is not None


def test_walkforward_no_bet_without_edge():
    # Features identiques (total_xg=3.2, line=2.5) melange 50/50 Over/Under,
    # cotes faires 2.0/2.0 -> modele => ~0.5, marche devigue => 0.5 : edge nul
    # -> AUCUN pari (regle stricte), ROI indetermine. Deterministe.
    over = _mkrows(300, goals=3, odds_over=2.0, odds_under=2.0)
    under = _mkrows(300, goals=1, odds_over=2.0, odds_under=2.0)
    res = walkforward_ou_roi(over + under, min_edge=0.0)
    assert res is not None
    assert res["stats"]["n"] == 0
    assert res["stats"]["roi"] is None


def test_walkforward_reports_league_split():
    rows = _mkrows(250, league="E0") + _mkrows(250, league="I1")
    res = walkforward_ou_roi(rows, min_edge=0.0)
    assert set(res["per_league"].keys()) == {"E0", "I1"}
    assert res["per_league"]["E0"]["n"] + res["per_league"]["I1"]["n"] == 375
    assert res["per_league"]["E0"]["n"] > 0 and res["per_league"]["I1"]["n"] > 0