"""Tests du module stats avancées (FBref/Understat) : normalisation et repli."""
from __future__ import annotations

import pandas as pd

import sources.fbref as fbref


def _matchlog_fbref() -> pd.DataFrame:
    """Deux matchs vus des deux camps (4 lignes de matchlog)."""
    return pd.DataFrame({
        "Date": ["2026-08-15", "2026-08-15", "2026-08-16", "2026-08-16"],
        "Venue": ["Home", "Away", "Home", "Away"],
        "Opponent": ["Man United", "Arsenal", "Liverpool", "Chelsea"],
        "team": ["Arsenal", "Man United", "Chelsea", "Liverpool"],
        "xg": [1.8, 0.9, 0.7, 2.1],
        "xga": [0.9, 1.8, 2.1, 0.7],
    })


def test_normalize_fbref_pivote_dom_ext() -> None:
    out = fbref._normalize_fbref(_matchlog_fbref())
    assert len(out) == 2
    row1 = out[(out["home_team"] == "Arsenal") & (out["away_team"] == "Man United")].iloc[0]
    assert row1["home_xg"] == 1.8
    assert row1["away_xg"] == 0.9
    row2 = out[(out["home_team"] == "Chelsea") & (out["away_team"] == "Liverpool")].iloc[0]
    assert row2["home_xg"] == 0.7
    assert row2["away_xg"] == 2.1


def test_normalize_fbref_colonnes_manquantes() -> None:
    df = pd.DataFrame({"Date": ["2026-08-15"], "team": ["Arsenal"]})
    assert fbref._normalize_fbref(df).empty


def test_normalize_fbref_deduplique() -> None:
    df = _matchlog_fbref()
    df = pd.concat([df, df.iloc[[0]]], ignore_index=True)
    out = fbref._normalize_fbref(df)
    assert len(out) == 2


def test_try_fbref_vide_retourne_none(monkeypatch) -> None:
    class _Fake:
        def __init__(self, **kwargs):
            pass

        def read_team_match_stats(self, force_cache=False):
            raise RuntimeError("403 Forbidden")

    monkeypatch.setattr(fbref.sd, "FBref", _Fake)
    assert fbref._try_fbref(["ENG-Premier League"], [2026], fbref.RateLimiter(0.0), False) is None


def test_fetch_repli_understat_trace_provenance(monkeypatch, tmp_path) -> None:
    import numpy as np

    def _fake_understat(names, seasons, limiter, force):
        return pd.DataFrame({
            "date": pd.to_datetime(["2026-08-15"]),
            "home_team": ["Arsenal"], "away_team": ["Man United"],
            "home_xg": [1.8], "away_xg": [0.9],
            "home_xa": [2.0], "away_xa": [1.0],
            "home_goals": [1], "away_goals": [0], "home_np_xg": [np.nan], "away_np_xg": [np.nan],
        })

    monkeypatch.setattr(fbref, "_try_fbref", lambda *a, **k: None)
    monkeypatch.setattr(fbref, "_fetch_understat", _fake_understat)
    monkeypatch.setattr(fbref, "_patch_understat_rosters", lambda: None)
    monkeypatch.setattr(fbref, "ADVANCED_CSV", tmp_path / "advanced_stats.csv")
    monkeypatch.setattr(fbref, "RAW_DIR", tmp_path)

    out = fbref.fetch()
    assert len(out) == 1
    assert fbref._read_stats_source() == "understat"
    assert (tmp_path / "advanced_stats.csv").exists()


def test_fetch_fbref_gardele_provider(monkeypatch, tmp_path) -> None:
    def _fake_fbref(names, seasons, limiter, force):
        return pd.DataFrame({
            "date": pd.to_datetime(["2026-08-15"]),
            "home_team": ["Arsenal"], "away_team": ["Man United"],
            "home_xg": [1.8], "away_xg": [0.9],
        })

    monkeypatch.setattr(fbref, "_try_fbref", _fake_fbref)
    monkeypatch.setattr(fbref, "_load_cached_xa", lambda: None)
    monkeypatch.setattr(fbref, "_patch_understat_rosters", lambda: None)
    monkeypatch.setattr(fbref, "ADVANCED_CSV", tmp_path / "advanced_stats.csv")
    monkeypatch.setattr(fbref, "RAW_DIR", tmp_path)

    out = fbref.fetch()
    assert len(out) == 1
    assert fbref._read_stats_source() == "fbref"
    assert "home_xa" in out.columns


def _schedule_sofascore() -> pd.DataFrame:
    """Calendrier 26-27 façon soccerdata Sofascore (résultats + affiches)."""
    return pd.DataFrame({
        "round": [1, 1, 1, 1],
        "week": [1, 1, 1, 1],
        "date": pd.to_datetime(["2026-08-21", "2026-08-22", "2026-08-15", "2026-08-16"]),
        "home_team": ["Arsenal", "Brentford", "Chelsea", "Liverpool"],
        "away_team": ["Coventry City", "Tottenham Hotspur", "Man City", "Newcastle"],
        "home_score": [float("nan"), float("nan"), 2, 0],
        "away_score": [float("nan"), float("nan"), 1, 1],
        "game_id": [1, 2, 3, 4],
    })


def test_normalize_schedule_garde_fixtures() -> None:
    out = fbref._normalize_schedule(_schedule_sofascore())
    assert len(out) == 4
    assert list(out.columns) == ["date", "home_team", "away_team", "home_score", "away_score"]
    assert out["home_score"].isna().sum() == 2
    assert out["date"].dt.tz is None


def test_normalize_schedule_colonnes_manquantes() -> None:
    df = pd.DataFrame({"date": ["2026-08-21"], "home_team": ["Arsenal"]})
    assert fbref._normalize_schedule(df).empty


def test_normalize_schedule_deduplique() -> None:
    df = _schedule_sofascore()
    df = pd.concat([df, df.iloc[[0]]], ignore_index=True)
    out = fbref._normalize_schedule(df)
    assert len(out) == 4


def test_try_sofascore_schedule_echec_retourne_none(monkeypatch) -> None:
    class _Fake:
        def __init__(self, **kwargs):
            pass

        def read_schedule(self, force_cache=False):
            raise RuntimeError("network down")

    monkeypatch.setattr(fbref.sd, "Sofascore", _Fake)
    assert fbref._try_sofascore_schedule(["ENG-Premier League"], [2026], fbref.RateLimiter(0.0), False) is None


def test_fetch_schedule_sofascore_prioritaire(monkeypatch) -> None:
    def _fake(names, seasons, limiter, force):
        return _schedule_sofascore()

    monkeypatch.setattr(fbref, "_try_sofascore_schedule", _fake)
    monkeypatch.setattr(fbref, "_try_understat_schedule", lambda *a, **k: None)
    monkeypatch.setattr(fbref, "_patch_understat_rosters", lambda: None)

    out = fbref.fetch_schedule()
    assert len(out) == 4
    assert "home_score" in out.columns


def test_fetch_schedule_repli_understat(monkeypatch) -> None:
    monkeypatch.setattr(fbref, "_try_sofascore_schedule", lambda *a, **k: None)
    monkeypatch.setattr(fbref, "_patch_understat_rosters", lambda: None)

    def _fake(names, seasons, limiter, force):
        df = _schedule_sofascore().copy()
        return df[["date", "home_team", "away_team", "home_score", "away_score"]]

    monkeypatch.setattr(fbref, "_try_understat_schedule", _fake)
    out = fbref.fetch_schedule()
    assert len(out) == 4


def test_soccerdata_current_season(monkeypatch) -> None:
    from datetime import datetime
    from config import current_season_years, soccerdata_current_season

    monkeypatch.setattr("config.datetime", datetime)
    start, _ = current_season_years(datetime(2026, 8, 18))
    assert start == 2026
    assert soccerdata_current_season() == [2026]
