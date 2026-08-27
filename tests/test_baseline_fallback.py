"""Tests du fallback A/B des baselines retenues (Phase 10 suite)."""
import os
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import baseline_fallback as bf  # noqa: E402


def test_is_enabled_default_off():
    os.environ["BASELINE_FALLBACK"] = "off"
    assert bf.is_enabled() is False


def test_predict_for_match_reel_et_inconnu():
    os.environ["BASELINE_FALLBACK"] = "on"
    df = pd.read_csv(bf.MASTER_CSV)
    r = df.iloc[500]
    m = {
        "league": r["league"],
        "home_team": r["home_team"],
        "away_team": r["away_team"],
        "date": str(pd.to_datetime(r["date"]).date()),
    }
    out = bf.predict_for_match(m)
    assert out is not None
    assert set(out.keys()) >= {"1x2", "ou25", "btts"}
    for v in out.values():
        assert abs(sum(v) - 1) < 1e-6 and all(0 <= p <= 1 for p in v)
    # inconnu -> None (pas de feature store live)
    assert bf.predict_for_match(
        {"league": "ZZ", "home_team": "X", "away_team": "Y", "date": "2099-01-01"}
    ) is None
    # live non archivé + ctx (feature store) -> probs valides
    live = bf.predict_for_match(
        {"league": "E0", "home_team": "Arsenal", "away_team": "Chelsea", "date": "2099-01-01"},
        ctx={"elo_h": 1850, "elo_a": 1800, "xg_h": 1.8, "xg_a": 1.2,
             "P1_open": 2.1, "PX_open": 3.4, "P2_open": 3.6},
    )
    assert live is not None and set(live.keys()) >= {"1x2", "ou25", "btts"}
    for v in live.values():
        assert abs(sum(v) - 1) < 1e-6 and all(0 <= p <= 1 for p in v)
    os.environ["BASELINE_FALLBACK"] = "off"


def test_build_utilise_formes_roulantes():
    from core import baseline_features as bfs

    os.environ["BASELINE_FALLBACK"] = "on"
    ctx = {
        "home_team": "Arsenal", "away_team": "Chelsea", "date": "2026-09-01",
        "elo_h": 1850, "elo_a": 1800, "xg_h": 1.8, "xg_a": 1.2,
    }
    feats = bfs.build(ctx)
    # Les formes viennent de l'historique réel, pas de la médiane master.
    assert feats["H_pts_L5"] != bfs.medians().get("H_pts_L5")
    assert 0 <= feats["H_pts_L5"] <= 3 and 0 <= feats["A_pts_L5"] <= 3
    assert isinstance(feats["Form_Diff_L5"], float)
    assert feats["Total_xG_L5"] >= 0
    os.environ["BASELINE_FALLBACK"] = "off"


def test_absence_impact_passe_au_modele():
    from core import baseline_features as bfs

    os.environ["BASELINE_FALLBACK"] = "on"
    base = {"home_team": "Arsenal", "away_team": "Chelsea", "date": "2026-09-01",
            "elo_h": 1850, "elo_a": 1800, "xg_h": 1.8, "xg_a": 1.2}
    sans = bfs.build(dict(base))
    avec = bfs.build(dict(base, absence_impact=0.7))
    # Par defaut (None) le feature vaut 0 (mediane historique) ; fourni -> valeur.
    assert sans["absence_impact_pondéré"] == 0.0
    assert avec["absence_impact_pondéré"] == 0.7
    # Note honnete : le modele est entraene sur historique absence=0 -> poids ~0,
    # donc la prediction ne bouge PAS encore. Le feature est correctement plombe
    # (42 features) et n'aura d'effet qu'apres accumulation live + re-entrainement.
    import core.baseline_fallback as bf
    p_sans = bf.predict_for_match({"league": "E0", "home_team": "Arsenal",
                                   "away_team": "Chelsea", "date": "2026-09-01"}, ctx=dict(base))
    p_avec = bf.predict_for_match({"league": "E0", "home_team": "Arsenal",
                                   "away_team": "Chelsea", "date": "2026-09-01"},
                                  ctx=dict(base, absence_impact=0.7))
    assert p_avec is not None and p_sans is not None
    for v in (p_sans, p_avec):
        # predict_from_features arrondit a 5 dec -> somme <= 1 a ~1.5e-5 pres.
        assert abs(sum(v["1x2"]) - 1) < 1e-3 and all(0 <= x <= 1 for x in v["1x2"])
    os.environ["BASELINE_FALLBACK"] = "off"


def test_calibration_active_sur_serving():
    import core.baseline_fallback as bf

    os.environ["BASELINE_FALLBACK"] = "on"
    ctx = {"home_team": "Arsenal", "away_team": "Chelsea", "date": "2026-09-01",
           "elo_h": 1850, "elo_a": 1800, "xg_h": 1.8, "xg_a": 1.2}
    m = {"league": "E0", "home_team": "Arsenal", "away_team": "Chelsea", "date": "2026-09-01"}
    os.environ["BASELINE_CALIBRATE"] = "on"
    p_cal = bf.predict_for_match(m, ctx=ctx)
    os.environ["BASELINE_CALIBRATE"] = "off"
    p_raw = bf.predict_for_match(m, ctx=ctx)
    os.environ["BASELINE_CALIBRATE"] = "off"
    os.environ["BASELINE_FALLBACK"] = "off"
    assert p_cal is not None and p_raw is not None
    # Calibration isotonique appliquee -> sorties differentes des brutales.
    assert p_cal["ou25"] != p_raw["ou25"] or p_cal["btts"] != p_raw["btts"]
    for v in (p_cal, p_raw):
        for mk in v:
            assert abs(sum(v[mk]) - 1) < 1e-3 and all(0 <= x <= 1 for x in v[mk])


def test_xgb_btts_gate():
    """Audit (2026-08-27) : XGB_BTTS=on bascule BTTS sur xgb_btts_tuned.pkl,
    sans toucher à 1X2/OU25, et reste off par défaut (zéro impact prod)."""
    import numpy as np

    os.environ["BASELINE_FALLBACK"] = "on"
    os.environ.pop("XGB_BTTS", None)  # défaut off
    df = pd.read_csv(bf.MASTER_CSV)
    r = df.iloc[2000]
    m = {"league": str(r["league"]), "home_team": str(r["home_team"]),
         "away_team": str(r["away_team"]),
         "date": str(pd.to_datetime(r["date"]).date())}

    off = bf.predict_for_match(m, markets=("1x2", "ou25", "btts"))
    os.environ["XGB_BTTS"] = "on"
    on = bf.predict_for_match(m, markets=("1x2", "ou25", "btts"))
    os.environ.pop("XGB_BTTS", None)
    os.environ["BASELINE_FALLBACK"] = "off"

    # défaut off -> RF ; on -> XGB (artefact différent)
    assert bf._btts_model_name() == "rf"
    os.environ["XGB_BTTS"] = "on"
    assert bf._btts_model_name() == "xgb_btts_tuned"
    os.environ.pop("XGB_BTTS", None)

    # 1X2 / OU25 inchangés entre les deux modes
    assert off["1x2"] == on["1x2"]
    assert off["ou25"] == on["ou25"]
    # BTTS valide et (généralement) différent du RF
    for v in (on["btts"],):
        assert abs(sum(v) - 1) < 1e-3 and all(0 <= x <= 1 for x in v)
    assert on["btts"] != off["btts"]


def test_nested_calibration_report_honnete():
    from core import backtest_walkforward as bw

    rep = bw.nested_calibration_report(["ou25", "btts"])
    for market in ("ou25", "btts"):
        assert market in rep
        # ECE honnete (calibrateur jamais sur eval) borne dans un range realiste.
        assert 0.0 <= rep[market]["ece_honest"] <= 0.3
        assert rep[market]["n_eval"] > 100
