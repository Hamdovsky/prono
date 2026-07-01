"""
Tests for market_engine.py — Surgical Market Selection, Precision Bets & Pro Insights
"""
import pytest
import math
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))


class TestGeneratePrecisionBets:
    def test_over_25_when_high_mc(self):
        from market_engine import generate_precision_bets
        bets = generate_precision_bets(1.8, 1.5, 60, 25, 15, 65, 40, 70, 9.0, 3.5, 'H', 'A', True, {})
        markets = [b['market'] for b in bets]
        assert 'Over 2.5 Buts' in markets

    def test_under_25_when_low_mc(self):
        from market_engine import generate_precision_bets
        bets = generate_precision_bets(0.8, 0.6, 40, 35, 25, 35, 20, 70, 9.0, 3.5, 'H', 'A', True, {})
        markets = [b['market'] for b in bets]
        assert 'Under 2.5 Buts' in markets

    def test_btts_when_both_xg_high(self):
        from market_engine import generate_precision_bets
        bets = generate_precision_bets(1.5, 1.3, 45, 30, 25, 50, 30, 70, 9.0, 3.5, 'H', 'A', True,
                                       {'home_big_chances': 2.0, 'away_big_chances': 1.8})
        markets = [b['market'] for b in bets]
        assert 'BTTS : OUI' in markets

    def test_clean_sheet_when_away_weak(self):
        from market_engine import generate_precision_bets
        bets = generate_precision_bets(1.5, 0.5, 70, 20, 10, 50, 30, 70, 9.0, 3.5, 'Home', 'Away', True,
                                       {'home_sot': 5, 'away_sot': 2.0})
        markets = [b['market'] for b in bets]
        assert any('Clean Sheet' in m for m in markets)

    def test_corners_over_when_high(self):
        from market_engine import generate_precision_bets
        bets = generate_precision_bets(1.5, 1.2, 50, 30, 20, 50, 30, 70, 11.0, 3.5, 'H', 'A', True, {})
        markets = [b['market'] for b in bets]
        assert 'Over 8.5 Corners' in markets

    def test_corners_under_when_low(self):
        from market_engine import generate_precision_bets
        bets = generate_precision_bets(1.5, 1.2, 50, 30, 20, 50, 30, 70, 6.0, 3.5, 'H', 'A', True, {})
        markets = [b['market'] for b in bets]
        assert 'Under 9.5 Corners' in markets

    def test_cards_over_when_high(self):
        from market_engine import generate_precision_bets
        bets = generate_precision_bets(1.5, 1.2, 50, 30, 20, 50, 30, 70, 9.0, 5.5, 'H', 'A', True, {})
        markets = [b['market'] for b in bets]
        assert 'Over 3.5 Cartons' in markets


class TestGenerateDnbAhBets:
    def test_dnb_home_when_strong(self):
        from market_engine import generate_dnb_ah_bets
        bets, dnb_h, dnb_a, dc_h, dc_a, dc_12 = generate_dnb_ah_bets(0.55, 0.25, 0.20, 'Home', 'H', 'A', 1.5, 1.0)
        markets = [b['market'] for b in bets]
        assert any('DNB' in m and 'H' in m for m in markets)

    def test_ah_home_dominance(self):
        from market_engine import generate_dnb_ah_bets
        bets, _, _, _, _, _ = generate_dnb_ah_bets(0.80, 0.12, 0.08, 'Home', 'H', 'A', 3.0, 1.0)
        markets = [b['market'] for b in bets]
        assert any('AH' in m for m in markets)

    def test_away_dominance(self):
        from market_engine import generate_dnb_ah_bets
        bets, _, _, _, _, _ = generate_dnb_ah_bets(0.10, 0.15, 0.75, 'Away', 'H', 'A', 1.0, 3.0)
        markets = [b['market'] for b in bets]
        assert any('AH' in m for m in markets)


class TestGetBestSurgicalMarket:
    def test_promosport_returns_classic(self):
        from market_engine import get_best_surgical_market
        match_obj = {'league': 'promosport'}
        primary, backup = get_best_surgical_market(
            match_obj, 'Home', 'Home Win', 0.55, 0.55, 0.25, 0.20,
            1.5, 1.2, 55, 'T1', 'H', 'A', 1.5, 1.5, 0.6, 0.4, 1.0, 1.0
        )
        assert primary is not None
        assert backup is None

    def test_high_xg_returns_over(self):
        from market_engine import get_best_surgical_market
        match_obj = {'league': 'Premier League', 'tournament_name': ''}
        primary, backup = get_best_surgical_market(
            match_obj, 'Home', 'Home Win', 0.60, 0.60, 0.25, 0.15,
            2.0, 1.8, 70, 'T1', 'H', 'A', 2.0, 2.0, 0.7, 0.5, 1.0, 1.0
        )
        assert primary is not None
        assert primary['confidence'] > 0

    def test_returns_tuple(self):
        from market_engine import get_best_surgical_market
        match_obj = {'league': 'Test', 'tournament_name': ''}
        result = get_best_surgical_market(
            match_obj, 'Draw', 'Draw', 0.34, 0.34, 0.33, 0.33,
            1.0, 1.0, 50, 'T2', 'H', 'A', 1.0, 1.0, 0.5, 0.5, 1.0, 1.0
        )
        assert len(result) == 2


class TestGenerateProInsights:
    def test_value_bet_insight(self):
        from market_engine import generate_pro_insights
        insights = generate_pro_insights('Home', 85, 'T1', 'premier league', True, 1.2, 1.0, 1.0, 'H', 'A', [], {}, 60)
        types = [i['type'] for i in insights]
        assert 'VALUE' in types

    def test_t1_high_confidence(self):
        from market_engine import generate_pro_insights
        insights = generate_pro_insights('Home', 85, 'T1', 'premier league', False, 0.9, 1.0, 1.0, 'H', 'A', [], {}, 60)
        types = [i['type'] for i in insights]
        assert 'SAFE' in types

    def test_t3_risk(self):
        from market_engine import generate_pro_insights
        insights = generate_pro_insights('Home', 60, 'T3', 'test league', False, 0.9, 1.0, 1.0, 'H', 'A', [], {}, 60)
        types = [i['type'] for i in insights]
        assert 'RISK' in types

    def test_motivation_imbalance(self):
        from market_engine import generate_pro_insights
        insights = generate_pro_insights('Home', 70, 'T2', 'test', False, 0.9, 1.5, 0.8, 'H', 'A', [], {}, 50)
        types = [i['type'] for i in insights]
        assert 'TACTICAL' in types


class TestCalculatePoissonScores:
    def test_home_favorite(self):
        from market_engine import calculate_poisson_scores
        scores = calculate_poisson_scores(4.5, 0.5, 'Home')
        assert len(scores) > 0
        assert all('score' in s and 'prob' in s for s in scores)

    def test_away_favorite(self):
        from market_engine import calculate_poisson_scores
        scores = calculate_poisson_scores(0.5, 4.5, 'Away')
        assert len(scores) > 0

    def test_draw_match(self):
        from market_engine import calculate_poisson_scores
        scores = calculate_poisson_scores(1.5, 1.5, 'Draw')
        assert len(scores) > 0
        for s in scores:
            h, a = map(int, s['score'].split(' - '))
            assert h == a

    def test_max_three_results(self):
        from market_engine import calculate_poisson_scores
        scores = calculate_poisson_scores(2.0, 2.0, 'Home')
        assert len(scores) <= 3


class TestEnsureExpectedScoreInCs:
    def test_inserts_expected_if_missing(self):
        from market_engine import ensure_expected_score_in_cs
        cs = [{'score': '2 - 1', 'prob': 15.0}]
        result = ensure_expected_score_in_cs(cs, '1 - 0', 1.5, 1.0)
        scores = [r['score'] for r in result]
        assert '1 - 0' in scores

    def test_deduplicates(self):
        from market_engine import ensure_expected_score_in_cs
        cs = [{'score': '1 - 0', 'prob': 12.0}, {'score': '1 - 0', 'prob': 10.0}]
        result = ensure_expected_score_in_cs(cs, None, 1.5, 1.0)
        assert len(result) == 1

    def test_max_three(self):
        from market_engine import ensure_expected_score_in_cs
        cs = [{'score': f'{i} - 0', 'prob': 15.0 - i} for i in range(5)]
        result = ensure_expected_score_in_cs(cs, None, 1.5, 1.0)
        assert len(result) <= 3


class TestBuildMainFour:
    def test_returns_3_items(self):
        from market_engine import build_main_four
        result = build_main_four('Home', 55, 1.5, 1.2, None, '', 'H', 'A', 'Home', 2, 1)
        assert len(result) == 3

    def test_ah_overrides_winner(self):
        from market_engine import build_main_four
        verdict = {'type': 'AH -1 Home', 'confidence': 80}
        result = build_main_four('Home', 55, 1.5, 1.2, verdict, '', 'H', 'A', 'Home', 2, 1)
        assert result[0]['label'] == 'Elite AH Pick'

    def test_high_xg_goals(self):
        from market_engine import build_main_four
        result = build_main_four('Home', 60, 1.8, 1.5, None, '', 'H', 'A', 'Home', 2, 1)
        goals = result[1]
        assert '+2.5' in goals['val']
