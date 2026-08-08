"""Tests du module Football-Data : parsing CSV, validation Div, saisons 404."""
from __future__ import annotations

import io

import pandas as pd
import pytest

from sources import football_data as fd


def _csv_bytes() -> bytes:
    return (
        "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,"
        "HS,AS,HST,AST,HC,AC,HY,AY,HR,AR,"
        "B365H,B365D,B365A,BFDH,PSH,AvgH,AvgD,AvgA,MaxH,"
        "B365CH,B365CD,B365CA,AvgCH,AvgCD,AvgCA,PSCH,MaxCH,"
        "B365>2.5,B365<2.5,Avg>2.5,Avg<2.5,B365C>2.5,AvgC>2.5,"
        "AHh,AHCh,B365AHH,B365AHA,B365CAHH,B365CAHA,AvgAHH,AvgAHA,AvgCAHH,AvgCAHA\n"
        "E0,10/08/2024,15:00,Arsenal,Chelsea,2,1,H,1,0,H,15,8,7,3,6,2,2,1,0,0,"
        "1.5,4.2,6.0,1.5,1.55,1.55,4.0,5.8,1.6,"
        "1.45,4.5,7.0,1.5,4.3,6.5,1.52,1.55,"
        "1.36,3.1,1.4,2.9,1.3,1.35,"
        "-1.5,-1.0,1.83,1.9,1.78,1.95,1.85,1.88,1.8,1.92\n"
    ).encode("utf-8-sig")


def test_read_csv_renomme_les_colonnes() -> None:
    df = fd._read_csv(_csv_bytes())
    expected = [
        "Div", "date", "kickoff_time", "home_team", "away_team", "fthg", "ftag", "ftr",
        "hthg", "htag", "htr", "hs", "away_shots", "hst", "ast", "hc", "ac",
        "hy", "ay", "hr", "ar",
        "odds_h_b365", "odds_d_b365", "odds_a_b365", "odds_h_bfd", "odds_h_ps",
        "odds_h_avg", "odds_d_avg", "odds_a_avg", "odds_h_max",
        "odds_h_close_b365", "odds_d_close_b365", "odds_a_close_b365",
        "odds_h_close_avg", "odds_d_close_avg", "odds_a_close_avg",
        "odds_h_close_ps", "odds_h_close_max",
        "odds_o25_b365", "odds_u25_b365", "odds_o25_avg", "odds_u25_avg",
        "odds_o25_close_b365", "odds_o25_close_avg",
        "ah_line", "ah_line_close", "odds_ah_h_b365", "odds_ah_a_b365",
        "odds_ah_h_close_b365", "odds_ah_a_close_b365",
        "odds_ah_h_avg", "odds_ah_a_avg", "odds_ah_h_close_avg", "odds_ah_a_close_avg",
    ]
    assert list(df.columns) == expected
    assert df.loc[0, "home_team"] == "Arsenal"
    assert df.loc[0, "odds_h_close_avg"] == 1.5
    assert df.loc[0, "odds_o25_close_avg"] == 1.35
    assert df.loc[0, "ah_line_close"] == -1.0
    assert df.loc[0, "odds_ah_h_close_avg"] == 1.8


def test_fetch_fixtures_filtre_top5(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    csv_body = (
        "Div,Date,Time,HomeTeam,AwayTeam,AvgH,AvgD,AvgA,B365>2.5\n"
        "E0,10/08/2026,15:00,Arsenal,Chelsea,1.55,4.0,5.8,1.4\n"
        "B1,11/08/2026,19:45,Club Brugge,Kortrijk,1.22,6.2,10.0,1.36\n"
    ).encode("utf-8-sig")

    class Resp:
        status_code = 200
        content = csv_body

        def raise_for_status(self) -> None:
            pass

    monkeypatch.setattr(fd, "FIXTURES_CSV", tmp_path / "football_data_fixtures.csv")
    monkeypatch.setattr("sources.football_data.requests.get",
                        lambda *a, **k: Resp())
    df = fd.fetch_fixtures(force=True)
    assert len(df) == 1  # seul E0 (Top-5) est conservé
    assert df.loc[0, "home_team"] == "Arsenal"
    assert df.loc[0, "odds_h_avg"] == 1.55
    assert (tmp_path / "football_data_fixtures.csv").exists()


def test_valid_div_accepte_le_bon_division() -> None:
    df = pd.DataFrame({"Div": ["E0", "E0", "E0", "E0"]})
    assert fd._valid_div(df, "E0")


def test_valid_div_rejette_un_fichier_incoherent() -> None:
    # Cas réel : la saison 2627 'SP1' contenait des données écossaises Div=SC1.
    df = pd.DataFrame({"Div": ["SC1", "SC1", "E0"]})
    assert not fd._valid_div(df, "SP1")


def test_valid_div_vide_ou_sans_colonne() -> None:
    assert not fd._valid_div(pd.DataFrame(), "E0")
    assert not fd._valid_div(pd.DataFrame({"A": [1]}), "E0")


def test_download_404_leve_season_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    class Resp:
        status_code = 404

        def raise_for_status(self) -> None:
            pass

    def fake_get(url, headers=None, timeout=None):
        return Resp()

    monkeypatch.setattr("sources.football_data.requests.get", fake_get)
    with pytest.raises(fd.SeasonNotFoundError):
        fd._download("2425", "E0")


def test_download_ok_renvoie_le_contenu(monkeypatch: pytest.MonkeyPatch) -> None:
    class Resp:
        status_code = 200
        content = b"Div,Date,HomeTeam,AwayTeam\nE0,10/08/2024,Arsenal,Chelsea\n"

        def raise_for_status(self) -> None:
            pass

    monkeypatch.setattr("sources.football_data.requests.get", lambda *a, **k: Resp())
    assert fd._download("2425", "E0") == Resp.content
