"""Tests du module Football-Data : parsing CSV, validation Div, saisons 404."""
from __future__ import annotations

import io

import pandas as pd
import pytest

from sources import football_data as fd


def _csv_bytes() -> bytes:
    return (
        "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,"
        "HS,AS,HST,AST,HC,AC,HY,AY,HR,AR,B365H,B365D,B365A,AvgH,AvgD,AvgA\n"
        "E0,10/08/2024,15:00,Arsenal,Chelsea,2,1,H,1,0,H,15,8,7,3,6,2,2,1,0,0,1.5,4.2,6.0,1.55,4.0,5.8\n"
        "E0,11/08/2024,12:30,Liverpool,Man United,0,0,D,0,0,D,10,9,4,4,5,4,1,2,0,0,2.1,3.4,3.6,2.0,3.3,3.7\n"
    ).encode("utf-8-sig")


def test_read_csv_renomme_les_colonnes() -> None:
    df = fd._read_csv(_csv_bytes())
    assert list(df.columns) == [
        "Div", "date", "Time", "home_team", "away_team", "fthg", "ftag", "ftr",
        "hthg", "htag", "htr", "hs", "away_shots", "hst", "ast", "hc", "ac",
        "hy", "ay", "hr", "ar", "odds_h_b365", "odds_d_b365", "odds_a_b365",
        "odds_h_avg", "odds_d_avg", "odds_a_avg",
    ]
    assert df.loc[0, "home_team"] == "Arsenal"
    assert df.loc[0, "ftr"] == "H"
    assert df.loc[1, "home_team"] == "Liverpool"


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
