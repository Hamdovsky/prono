"""Tests du module ClubElo : probe HTTP, chaîne de repli, provenance."""
from __future__ import annotations

import pandas as pd
import pytest

import sources.clubelo as clubelo


def _fd_results() -> pd.DataFrame:
    return pd.DataFrame({
        "date": ["2024-01-10", "2024-01-10"],
        "league": ["E0", "E0"],
        "season": ["2425", "2425"],
        "home_team": ["Arsenal", "Chelsea"],
        "away_team": ["Chelsea", "Arsenal"],
        "ftr": ["H", "A"],
    })


def _date_csv(data: str = "1,Arsenal,ENG,1,2000.0,2026-08-01,2026-08-09\n") -> str:
    return "Rank,Club,Country,Level,Elo,From,To\n" + data


def test_api_reachable_quand_les_donnees_repondent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clubelo, "_http_get", lambda *a, **k: _date_csv())
    assert clubelo._api_reachable() is True


def test_api_reachable_faux_sans_donnees(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clubelo, "_http_get", lambda *a, **k: "Rank,Club,Country,Level,Elo,From,To\n")
    assert clubelo._api_reachable() is False


def test_api_reachable_faux_sur_erreur(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*a, **k):
        raise OSError("injoignable")

    monkeypatch.setattr(clubelo, "_http_get", boom)
    assert clubelo._api_reachable() is False


def test_fetch_api_ok_donne_provenance_clubelo(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setattr(clubelo, "CLUBELO_DIR", tmp_path)
    monkeypatch.setattr(clubelo, "_api_reachable", lambda *a, **k: True)
    hist = pd.DataFrame({"from": ["2024-01-01"], "elo": [2050.0], "team_raw": ["Man City"]})
    monkeypatch.setattr(clubelo, "_fetch_from_api", lambda *a, **k: hist)

    df, source = clubelo.fetch_histories()
    assert source == "clubelo"
    assert df.loc[0, "elo"] == 2050.0
    assert (tmp_path / clubelo._SOURCE_MARKER).read_text(encoding="utf-8") == "clubelo"


def test_fetch_api_down_calcule_local(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setattr(clubelo, "CLUBELO_DIR", tmp_path)
    monkeypatch.setattr(clubelo, "_api_reachable", lambda *a, **k: False)

    df, source = clubelo.fetch_histories(fallback_results=_fd_results())
    assert source == "local"
    assert (tmp_path / clubelo._SOURCE_MARKER).read_text(encoding="utf-8") == "local"
    assert len(df) == 4  # 2 relevés (domicile + extérieur) par match


def test_fetch_down_utilise_cache_frais_provenance_cache(monkeypatch: pytest.MonkeyPatch,
                                                         tmp_path) -> None:
    monkeypatch.setattr(clubelo, "CLUBELO_DIR", tmp_path)
    pd.DataFrame({"from": ["2024-01-01"], "elo": [1600.0], "team_raw": ["Arsenal"]}) \
        .to_csv(tmp_path / "elo_history.csv", index=False)
    (tmp_path / clubelo._SOURCE_MARKER).write_text("clubelo", encoding="utf-8")
    monkeypatch.setattr(clubelo, "_api_reachable", lambda *a, **k: False)

    df, source = clubelo.fetch_histories(max_age=1)
    assert source == "cache"
    assert df.loc[0, "elo"] == 1600.0
    assert (tmp_path / clubelo._SOURCE_MARKER).read_text(encoding="utf-8") == "cache"


def test_fetch_down_utilise_cache_local_separe(monkeypatch: pytest.MonkeyPatch,
                                                tmp_path) -> None:
    monkeypatch.setattr(clubelo, "CLUBELO_DIR", tmp_path)
    pd.DataFrame({"from": ["2024-01-01"], "elo": [1500.0], "team_raw": ["Arsenal"]}) \
        .to_csv(tmp_path / clubelo.ELO_CACHE_LOCAL, index=False)
    (tmp_path / clubelo._SOURCE_MARKER).write_text("local", encoding="utf-8")
    monkeypatch.setattr(clubelo, "_api_reachable", lambda *a, **k: False)

    _, source = clubelo.fetch_histories(max_age=1)
    assert source == "local"


def test_fetch_down_officiel_prefere_au_local(monkeypatch: pytest.MonkeyPatch,
                                              tmp_path) -> None:
    """Le cache officiel ClubElo doit toujours primer sur le cache local."""
    monkeypatch.setattr(clubelo, "CLUBELO_DIR", tmp_path)
    pd.DataFrame({"from": ["2024-01-01"], "elo": [2050.0], "team_raw": ["Man City"]}) \
        .to_csv(tmp_path / clubelo.ELO_CACHE_OFFICIAL, index=False)
    pd.DataFrame({"from": ["2024-01-01"], "elo": [1500.0], "team_raw": ["Man City"]}) \
        .to_csv(tmp_path / clubelo.ELO_CACHE_LOCAL, index=False)
    (tmp_path / clubelo._SOURCE_MARKER).write_text("local", encoding="utf-8")
    monkeypatch.setattr(clubelo, "_api_reachable", lambda *a, **k: False)

    df, source = clubelo.fetch_histories(max_age=1)
    assert source == "cache"
    assert df.loc[0, "elo"] == 2050.0
