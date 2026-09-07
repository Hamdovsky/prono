import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import prediction_engine as pe


def test_promosport_blend_off_is_noop():
    os.environ["PROMOSPORT_BLEND"] = "off"
    try:
        h, d, a, src = pe._apply_promosport_blend(
            0.5, 0.3, 0.2, {"homeTeam": "X", "awayTeam": "Y"}, {}, "Base")
        assert (h, d, a) == (0.5, 0.3, 0.2)
        assert src == "Base"
    finally:
        os.environ.pop("PROMOSPORT_BLEND", None)


def test_promosport_blend_on_normalizes_and_tags_source():
    os.environ["PROMOSPORT_BLEND"] = "on"
    try:
        an = {}
        h, d, a, src = pe._apply_promosport_blend(
            0.5, 0.3, 0.2,
            {"homeTeam": "Real Madrid", "awayTeam": "Barcelona", "league": "La Liga"},
            an, "Base")
        assert abs(h + d + a - 1.0) < 1e-6
        assert "Promosport" in src
        assert "PromosportBlend" in an
    finally:
        os.environ.pop("PROMOSPORT_BLEND", None)


def test_promosport_blend_votes_raise_weight():
    os.environ["PROMOSPORT_BLEND"] = "on"
    try:
        an_nov = {}
        hn, dn, an_, _ = pe._apply_promosport_blend(
            0.5, 0.3, 0.2,
            {"homeTeam": "Real Madrid", "awayTeam": "Barcelona", "league": "La Liga"},
            an_nov, "Base")
        an_v = {}
        hv, dv, av, _ = pe._apply_promosport_blend(
            0.5, 0.3, 0.2,
            {"homeTeam": "Real Madrid", "awayTeam": "Barcelona", "league": "La Liga",
             "vote_home": 70, "vote_draw": 20, "vote_away": 10},
            an_v, "Base")
        # With votes the model is trusted more -> home prob shifts further from 0.5
        assert abs(hv - 0.5) >= abs(hn - 0.5) - 1e-9
        assert "votes=yes" in an_v["PromosportBlend"]
        assert "votes=no" in an_nov["PromosportBlend"]
    finally:
        os.environ.pop("PROMOSPORT_BLEND", None)


def test_promosport_blend_weight_cap():
    os.environ["PROMOSPORT_BLEND"] = "on"
    os.environ["PROMOSPORT_BLEND_WEIGHT"] = "0.9"  # above cap
    try:
        an = {}
        pe._apply_promosport_blend(
            0.5, 0.3, 0.2,
            {"homeTeam": "Real Madrid", "awayTeam": "Barcelona", "league": "La Liga",
             "vote_home": 70, "vote_draw": 20, "vote_away": 10},
            an, "Base")
        # w = min(0.5, 0.5 * 1.6) = 0.5
        assert "w=0.50" in an["PromosportBlend"]
    finally:
        os.environ.pop("PROMOSPORT_BLEND", None)
        os.environ.pop("PROMOSPORT_BLEND_WEIGHT", None)
