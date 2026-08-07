"""Tests du pont Postgres : construction des clés et correspondance master -> prod."""
from __future__ import annotations

import pandas as pd
import pytest

from build import pg_export as pe
from team_mapping import TeamMapper


def test_build_lookup_cle_par_jour_utc() -> None:
    rows = [
        {"id": 1, "homeTeam": "Manchester United", "awayTeam": "Chelsea",
         "startTimestamp": 1704844800},  # 2024-01-10 00:00 UTC
        {"id": 2, "homeTeam": "Arsenal", "awayTeam": "Liverpool", "startTimestamp": None},
        {"id": 3, "homeTeam": "Barcelona", "awayTeam": "Real Madrid",
         "startTimestamp": 1704931200},  # 2024-01-11 00:00 UTC
    ]
    lookup = pe.build_lookup(rows)
    assert lookup[("manchester united", "chelsea", "2024-01-10")] == ["1"]
    assert lookup[("barcelona", "real madrid", "2024-01-11")] == ["3"]
    # Ligne sans startTimestamp ignorée.
    assert ("arsenal", "liverpool") not in [k[:2] for k in lookup]


def test_candidates_ne_capture_que_les_matchs_correspondants() -> None:
    lookup = {
        ("manchester united", "chelsea", "2024-01-10"): ["abc123"],
    }
    master = pd.DataFrame([
        {"date": pd.Timestamp("2024-01-10"), "home_team": "Man Utd", "away_team": "Chelsea",
         "odds_h_avg": 2.1, "odds_d_avg": 3.4, "odds_a_avg": 3.8,
         "home_xg": 1.6, "away_xg": 0.9, "H_pts_L5": 2.2, "A_pts_L5": 1.4},
        {"date": pd.Timestamp("2024-01-11"), "home_team": "Arsenal", "away_team": "Liverpool",
         "odds_h_avg": 1.5, "odds_d_avg": 4.2, "odds_a_avg": 7.0,
         "home_xg": None, "away_xg": None, "H_pts_L5": None, "A_pts_L5": None},
    ])
    matches = pe._candidates(master, lookup, TeamMapper())
    assert len(matches) == 1
    m = matches[0]
    assert m["id"] == "abc123"
    # L'alias 'Man Utd' est résolu vers le nom canonique prod 'Manchester United'.
    assert m["odds"] == (2.1, 3.4, 3.8)
    assert m["xg"] == (1.6, 0.9)
    assert m["form"] == (2.2, 1.4)


def test_num_convertit_nan_en_none() -> None:
    s = pd.Series([1.5, float("nan"), None, 0.0])
    assert pe._num(s, 0) == 1.5
    assert pe._num(s, 1) is None
    assert pe._num(s, 2) is None
    assert pe._num(s, 3) == 0.0
