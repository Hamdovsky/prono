"""
Tests for confidence_engine.py — Confidence Calibration, Risk Assessment & Verdict
"""
import pytest
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))


class TestDetermineVerdict:
    def test_high_confidence_safe(self):
        from confidence_engine import determine_verdict
        assert determine_verdict(85, 0.25, 0.0) == "SAFE BET"

    def test_medium_confidence_risky(self):
        from confidence_engine import determine_verdict
        assert determine_verdict(65, 0.25, 0.0) == "RISKY"

    def test_low_confidence_no_bet(self):
        from confidence_engine import determine_verdict
        assert determine_verdict(45, 0.25, 0.0) == "NO BET"

    def test_high_draw_draw_trap(self):
        from confidence_engine import determine_verdict
        assert determine_verdict(75, 0.45, 0.0) == "DRAW TRAP"

    def test_confluence_penalty_no_bet(self):
        from confidence_engine import determine_verdict
        assert determine_verdict(85, 0.25, 0.40) == "NO BET"


class TestAssessRisk:
    def test_t1_low_risk(self):
        from confidence_engine import assess_risk
        score, reasons, suspicious, safe = assess_risk(
            'T1', 1.0, 1.0, False, False,
            2.0, 3.5, 4.0, 2.0, 4.0,
            0.5, 0.2, {'data_completeness': 90}, 85
        )
        assert score < 3
        assert safe is True

    def test_t3_high_risk(self):
        from confidence_engine import assess_risk
        score, reasons, suspicious, safe = assess_risk(
            'T3', 0.8, 0.8, True, True,
            2.0, 3.5, 4.0, 2.0, 4.0,
            0.5, 0.2, {'data_completeness': 40}, 60
        )
        assert score >= 5
        assert suspicious is True

    def test_dead_zone_risk(self):
        from confidence_engine import assess_risk
        score, reasons, _, _ = assess_risk(
            'T2', 0.5, 0.5, True, True,
            2.0, 3.5, 4.0, 2.0, 4.0,
            0.5, 0.2, {'data_completeness': 80}, 70
        )
        assert score >= 4

    def test_steam_move_risk(self):
        from confidence_engine import assess_risk
        score, reasons, _, _ = assess_risk(
            'T2', 1.0, 1.0, False, False,
            2.0, 3.5, 4.0, 3.5, 4.0,  # big drop on home
            0.30, 0.2, {'data_completeness': 80}, 70
        )
        assert any('Steam' in r or 'مريبة' in r for r in reasons)

    def test_missing_data_risk(self):
        from confidence_engine import assess_risk
        score, reasons, _, _ = assess_risk(
            'T2', 1.0, 1.0, False, False,
            2.0, 3.5, 4.0, 2.0, 4.0,
            0.5, 0.2, {'data_completeness': 40}, 70
        )
        assert any('بيانات' in r for r in reasons)


class TestApplyVetoShield:
    def test_low_confidence_veto(self):
        from confidence_engine import apply_veto_shield
        no_bet, verdict, veto, reason = apply_veto_shield(
            0, 10.0, 50, 80, 'T1', {}
        )
        assert no_bet is True
        assert verdict == "NO BET"

    def test_high_risk_veto(self):
        from confidence_engine import apply_veto_shield
        no_bet, verdict, veto, reason = apply_veto_shield(
            16, 80, 50, 80, 'T1', {}
        )
        assert no_bet is True
        assert "SHIELDED" in verdict

    def test_force_predict_bypasses_veto(self):
        from confidence_engine import apply_veto_shield
        no_bet, verdict, veto, reason = apply_veto_shield(
            16, 80, 50, 80, 'T1', {'force_predict': True}
        )
        assert no_bet is False

    def test_normal_match_no_veto(self):
        from confidence_engine import apply_veto_shield
        no_bet, verdict, veto, reason = apply_veto_shield(
            3, 80, 50, 80, 'T1', {}
        )
        assert no_bet is False


class TestApplyDrawAndWorldCup:
    def test_draw_multiplier_applied(self):
        from confidence_engine import apply_draw_and_world_cup
        p_h, p_d, p_a, adj = apply_draw_and_world_cup(
            0.45, 0.30, 0.25, 'premier league', '', {}, {}
        )
        assert abs(p_h + p_d + p_a - 1.0) < 0.001

    def test_world_cup_ranking_boost(self):
        from confidence_engine import apply_draw_and_world_cup
        features = {'fifa_rank_h': 5, 'fifa_rank_a': 30}
        p_h, p_d, p_a, adj = apply_draw_and_world_cup(
            0.40, 0.30, 0.30, 'world cup', '', features, {}
        )
        assert abs(p_h + p_d + p_a - 1.0) < 0.001
        assert adj < 0  # confidence reduced for WC


class TestApplyPostVerdict:
    def test_safe_bet(self):
        from confidence_engine import apply_post_verdict
        analysis = {}
        v = apply_post_verdict(85, 80, 1.0, 'T1', analysis)
        assert v == "SAFE BET"

    def test_risky_bet(self):
        from confidence_engine import apply_post_verdict
        v = apply_post_verdict(55, 50, 0.9, 'T2', {})
        assert v == "RISKY BET"

    def test_surgical_strike(self):
        from confidence_engine import apply_post_verdict
        analysis = {}
        v = apply_post_verdict(92, 90, 1.2, 'T1', analysis)
        assert "SURGICAL" in v

    def test_surgical_needs_t1(self):
        from confidence_engine import apply_post_verdict
        analysis = {}
        v = apply_post_verdict(92, 90, 1.2, 'T2', analysis)
        assert "SURGICAL" not in v


class TestBuildAnalysisReport:
    def test_returns_10_point_analysis(self):
        from confidence_engine import build_analysis_report
        features = {'h2h_win_rate': 60, 'h2h_games': 10, 'h_sot': 5, 'a_sot': 4,
                     'h_bc': 2, 'a_bc': 1.5, 'h_pass_acc': 82, 'weather_temp': 22,
                     'home_injury_impact': 0, 'news_sentiment': 0.1}
        report = build_analysis_report(
            features, 'Home', 'Away', 'Home', 'Home Win',
            0.5, 0.3, 60, 50, 0.1, -0.05,
            1.8, 1.2, 1.05, 0.98, 'Offensive', 'Counter',
            1.1, 0.9, 'Standard', False, False,
            0.0, False, 0.0, 1.0, 75, 'John Smith', 0.55, features
        )
        assert len(report) == 10
        assert '1_Form' in report
        assert '10_Smart_Indicators' in report


class TestOverconfidenceVeto:
    """Veto Guard / Safety Bracket : prob >= 0.70 mais bracket < 0.60 → NO BET."""

    def test_high_prob_weak_bracket_veto(self):
        from confidence_engine import overconfidence_veto
        veto, reason = overconfidence_veto(0.78, {'70-80': {'accuracy': 0.382, 'count': 68}})
        assert veto is True
        assert 'NO BET' in reason

    def test_high_prob_strong_bracket_no_veto(self):
        from confidence_engine import overconfidence_veto
        veto, _ = overconfidence_veto(0.78, {'70-80': {'accuracy': 0.82, 'count': 68}})
        assert veto is False

    def test_low_prob_never_veto(self):
        from confidence_engine import overconfidence_veto
        veto, _ = overconfidence_veto(0.55, {'50-60': {'accuracy': 0.20, 'count': 100}})
        assert veto is False

    def test_insufficient_samples_no_veto(self):
        from confidence_engine import overconfidence_veto
        veto, _ = overconfidence_veto(0.78, {'70-80': {'accuracy': 0.10, 'count': 2}})
        assert veto is False

    def test_injected_bracket_accuracy(self):
        from confidence_engine import overconfidence_veto
        brackets = {'80-90': {'accuracy': 0.182, 'count': 68}, '70-80': {'accuracy': 0.90, 'count': 68}}
        veto, reason = overconfidence_veto(0.85, brackets)
        assert veto is True
        assert '80-90' in reason

    def test_real_reports_merge(self):
        from confidence_engine import load_bracket_accuracy, overconfidence_veto
        brackets = load_bracket_accuracy()
        assert isinstance(brackets, dict)
        assert '70-80' in brackets or not brackets  # données dispo ou chargement vide toléré
