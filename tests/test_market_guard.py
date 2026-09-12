"""
Tests for market_guard.py — divergence marché (E17) + biais domicile Asie.
"""
import pytest
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))


class TestCheckMarketDivergence:
    def test_no_odds_returns_none(self):
        from market_guard import check_market_divergence
        assert check_market_divergence(0.5, 0.3, 0.2, 0, 0, 0) is None
        assert check_market_divergence(0.5, 0.3, 0.2, None, None, None) is None
        assert check_market_divergence(0.5, 0.3, 0.2, 1.0, 3.0, 4.0) is None

    def test_aligned_model_not_flagged(self):
        from market_guard import check_market_divergence
        b = check_market_divergence(0.5, 0.28, 0.22, 2.1, 3.7, 4.7)
        assert b['flagged'] is False
        assert abs(b['edges_pp']['home']) < 12

    def test_j1_home_overrate_flagged(self):
        # Gamba 69% vs book ~27% (odds 3.67/3.77/1.91) -> veto home
        from market_guard import check_market_divergence
        b = check_market_divergence(0.69, 0.22, 0.09, 3.67, 3.77, 1.91)
        assert b['flagged'] is True
        assert b['side'] == 'home'
        assert b['edge_pp'] > 12

    def test_obolon_away_edge_flagged(self):
        # Cherkasy-Obolon : book home 68.5 vs modèle 41 (le pire écart, côté
        # home) ET away modèle 33 vs book 9.7 -> veto dans les deux cas.
        from market_guard import check_market_divergence
        b = check_market_divergence(0.41, 0.27, 0.33, 1.34, 4.21, 9.44)
        assert b['flagged'] is True
        assert b['edges_pp']['away'] > 12
        assert b['side'] == 'home'  # |−27| > |+23|

    def test_devigged_implied_sums_100(self):
        from market_guard import check_market_divergence
        b = check_market_divergence(0.4, 0.3, 0.3, 2.0, 3.5, 3.5)
        # edges home/draw/away : déviggar annule l'overround -> edge home ~ -8
        assert abs(b['edges_pp']['home']) < 12.1  # seuil documenté, pas un nombre magique de confort

    def test_threshold_configurable(self):
        from market_guard import check_market_divergence
        cfg = {'max_divergence_pp': 3.0}
        b = check_market_divergence(0.55, 0.28, 0.17, 2.1, 3.7, 4.7, cfg=cfg)
        assert b['flagged'] is True
        assert b['max_pp'] == 3.0


class TestAsianHomeDamp:
    def test_damps_asian_home_and_renormalizes(self, monkeypatch):
        from market_guard import apply_asian_home_damp
        monkeypatch.delenv('ASIAN_HA_FIX', raising=False)
        h, d, a = apply_asian_home_damp(0.69, 0.22, 0.09, {'league': 'J1 League'})
        assert h < 0.69 and a > 0.09
        assert h + d + a == pytest.approx(1.0)
        # 0.69*0.85=0.5865 ; /0.8965 ≈ 0.654
        assert h == pytest.approx(0.654, abs=0.002)

    def test_other_leagues_untouched(self, monkeypatch):
        from market_guard import apply_asian_home_damp
        monkeypatch.delenv('ASIAN_HA_FIX', raising=False)
        assert apply_asian_home_damp(0.64, 0.23, 0.13, {'league': '2. Bundesliga'}) == (0.64, 0.23, 0.13)

    def test_flag_off(self, monkeypatch):
        from market_guard import apply_asian_home_damp
        monkeypatch.setenv('ASIAN_HA_FIX', 'off')
        assert apply_asian_home_damp(0.69, 0.22, 0.09, {'league': 'K League 1'}) == (0.69, 0.22, 0.09)

    def test_is_asian_league(self):
        from market_guard import is_asian_league
        assert is_asian_league('J1 League')
        assert is_asian_league('K League 2')
        assert is_asian_league('  Thai League  ')
        assert not is_asian_league('Premier League')
        assert not is_asian_league(None)


class TestHomeAdvantageFromStats:
    def test_small_sample_falls_back(self):
        from market_guard import home_advantage_from_stats
        assert home_advantage_from_stats(3, 1.2, 2.1, True) == 1.08  # J1 : n=3, ratio bruit
        assert home_advantage_from_stats(8, 1.9, 1.1, True) == 1.08
        assert home_advantage_from_stats(5, 1.5, 1.1, False) == 1.15
        assert home_advantage_from_stats(0, None, None, False) == 1.15

    def test_enough_rows_uses_ratio(self):
        from market_guard import home_advantage_from_stats
        assert home_advantage_from_stats(200, 1.65, 1.20, False) == pytest.approx(1.375)
        assert home_advantage_from_stats(500, 1.55, 1.35, True) == pytest.approx(1.148, abs=0.001)

    def test_sane_clamps(self):
        from market_guard import home_advantage_from_stats
        assert home_advantage_from_stats(500, 4.0, 1.0, False) == 1.45  # ratio 4.0 = bruit
        assert home_advantage_from_stats(500, 0.4, 1.0, False) == 0.90  # ratio 0.4 = aberrant
        assert home_advantage_from_stats(100, 0.0, 1.0, False) == 1.15  # avg nulle


class TestConfig:
    def test_load_guard_config_reads_file(self):
        from market_guard import load_guard_config
        c = load_guard_config()
        assert c['max_divergence_pp'] == 12.0
        assert c['asian_home_damp'] > 0
        assert 'j1 league' in c['asian_leagues']
