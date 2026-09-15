"""
tests/test_fotmob_client.py — parseur fotmobClient (E37 FotMob).
Sans rÉseau : on monkeypatch fotmobClient._http_get pour rejouer un payload
/api/data/* rÉel (structure vÉrifiÉe en session). Marqueur smoke => jouÉ au commit.
"""
from __future__ import annotations
import pytest

import fotmobClient as fc

# payload /api/data/matchDetails (stats d'ÉQUIPE content.stats.Periods)
MATCH_DETAILS = {
    "content": {
        "stats": {
            "Periods": {
                "All": {
                    "stats": [
                        {"key": "top_stats", "stats": [
                            {"title": "Ball possession", "key": "BallPossesion", "stats": [30, 70]},
                            {"title": "Expected goals (xG)", "key": "expected_goals", "stats": ["1.33", "2.81"]},
                            {"title": "Total shots", "key": "total_shots", "stats": [14, 22]},
                            {"title": "Shots on target", "key": "ShotsOnTarget", "stats": [6, 7]},
                        ]},
                        {"key": "defence", "stats": [
                            {"title": "Corners", "key": "corners", "stats": [5, 3]},
                        ]},
                    ]
                },
                "FirstHalf": {
                    "stats": [
                        {"key": "top_stats", "stats": [
                            {"title": "Expected goals (xG)", "key": "expected_goals", "stats": ["0.97", "0.97"]},
                        ]},
                        {"key": "defence", "stats": [
                            {"title": "Corners", "key": "corners", "stats": [4, 3]},
                        ]},
                    ]
                },
            }
        }
    }
}

# payload /api/data/matches?date=
MATCHES_DAY = {
    "leagues": [{
        "name": "Premier League",
        "matches": [{
            "id": 5795448,
            "home": {"name": "Coventry City", "score": 0},
            "away": {"name": "Brighton", "score": 5},
            "status": {"finished": True, "reason": {"short": "FT"}},
        }],
    }]
}


def _fake_http(payload):
    def _get(url, match_id=None, timeout=15):
        return payload
    return _get


@pytest.mark.smoke
@pytest.mark.local
def test_get_match_details_team_stats(monkeypatch):
    monkeypatch.setattr(fc, "_http_get", _fake_http(MATCH_DETAILS))
    d = fc.get_match_details("5795448")
    assert d["xg_home"] == pytest.approx(1.33)
    assert d["xg_away"] == pytest.approx(2.81)
    assert d["corners_home"] == 5 and d["corners_away"] == 3
    assert d["shots_home"] == 14 and d["shots_away"] == 22
    assert d["shots_on_target_home"] == 6
    assert d["possession_home"] == pytest.approx(30.0)
    # HT de 1re mi-temps (pÉriode FirstHalf)
    assert d["xg_ht_home"] == pytest.approx(0.97)
    assert d["corners_ht_home"] == 4
    # score de MT volontairement absent (vient de livescore)
    assert d["ht_score_home"] is None and d["ht_score_away"] is None


@pytest.mark.smoke
@pytest.mark.local
def test_get_match_details_missing_returns_none(monkeypatch):
    monkeypatch.setattr(fc, "_http_get", _fake_http(None))
    assert fc.get_match_details("1") is None


@pytest.mark.smoke
@pytest.mark.local
def test_get_match_details_missing_stats(monkeypatch):
    monkeypatch.setattr(fc, "_http_get", _fake_http({"content": {"stats": {}}}))
    d = fc.get_match_details("1")
    assert d is None  # Pas de Periods -> pas de stats


@pytest.mark.smoke
@pytest.mark.local
def test_get_matches_by_date_normalizes(monkeypatch):
    monkeypatch.setattr(fc, "_http_get", _fake_http(MATCHES_DAY))
    ms = fc.get_matches_by_date("20260913")
    assert len(ms) == 1
    m = ms[0]
    assert m["id"] == "5795448"
    assert m["home"] == "Coventry City" and m["away"] == "Brighton"
    assert m["league"] == "Premier League"
    assert m["status"] == "FT"
    assert m["home_score"] == 0 and m["away_score"] == 5


@pytest.mark.smoke
@pytest.mark.local
def test_pick_and_ha_helpers():
    items = fc._period_items(MATCH_DETAILS["content"]["stats"]["Periods"], "All")
    ha = fc._ha(fc._pick_item(items, "expected_goals"))
    assert ha == (pytest.approx(1.33), pytest.approx(2.81))
    assert fc._pick_item(items, "nonexistent") is None
    assert fc._ha(None) == (None, None)
