"""Tests parsing Sofascore lineups/injuries (Étape E) — fixtures, pas de réseau."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.sofascore_bypass import parse_injuries, parse_lineups  # noqa: E402


LINEUPS = {
    "confirmed": True,
    "home": {
        "team": {"name": "Schalke 04"},
        "formation": "4-4-2",
        "players": [
            {"player": {"name": "Luca", "position": {"position": "G"}}, "shirtNumber": 1},
            {"player": {"name": "Ben", "position": "M"}, "shirtNumber": 7, "substitute": True},
        ],
    },
    "away": {"team": {"name": "Halle"}, "players": []},
}


INJURIES = {
    "injuries": [
        {"player": {"name": "Foo", "position": {"position": "D"}},
         "team": {"name": "Schalke 04"}, "statusType": "INJURED", "details": "knee"},
    ]
}


def test_parse_lineups_structure():
    out = parse_lineups(LINEUPS)
    assert out["found"] and out["confirmed"]
    home = out["teams"][0]
    assert home["formation"] == "4-4-2" and home["n_players"] == 2
    assert home["players"][0]["name"] == "Luca" and home["players"][0]["position"] == "G"
    assert out["teams"][1]["n_players"] == 0


def test_parse_injuries_structure():
    out = parse_injuries(INJURIES)
    assert out["found"] and out["n"] == 1
    it = out["injuries"][0]
    assert it["player"] == "Foo" and it["status"] == "INJURED" and it["detail"] == "knee"


def test_parse_lineups_vide():
    out = parse_lineups(None)
    assert out["found"] is False and out["teams"] == []
