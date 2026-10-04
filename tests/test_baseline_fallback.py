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


def test_hook_prediction_engine_appelle_bien_le_fallback():
    """E81 : le hook de prediction_engine nelevait jamais.

    `ctx` utilisait `date` (core/prediction_engine.py) avant que la variable ne
    soit assignee -> UnboundLocalError avale par `except Exception: return None`.
    Resultat : `predict_for_match` n'etait JAMAIS appele, et le champ
    `baseline_fallback` valait toujours None, sans trace. Ce test verrouille
    le fait que le hook appelle reellement le fallback et lui transmet `date`.
    """
    sys.path.insert(0, str(ROOT / "core"))
    import core.prediction_engine as pe

    os.environ["BASELINE_FALLBACK"] = "on"
    appel = {}

    def faux(key, ctx, markets=("1x2", "ou25", "btts")):
        appel["key"] = key
        appel["ctx"] = ctx
        return {"1x2": [0.4, 0.3, 0.3]}

    original = bf.predict_for_match
    bf.predict_for_match = faux
    try:
        out = pe._attach_baseline_fallback(
            {
                "homeTeam": "Arsenal", "awayTeam": "Chelsea",
                "league": "E0", "date": "2026-09-01",
                "odds_home_open": 2.1, "odds_draw_open": 3.4, "odds_away_open": 3.6,
            },
            xg_h=1.8, xg_a=1.2,
        )
    finally:
        bf.predict_for_match = original
        os.environ["BASELINE_FALLBACK"] = "off"

    assert out == {"1x2": [0.4, 0.3, 0.3]}, "le hook doit propager la sortie"
    assert appel, "predict_for_match n'a pas ete appele"
    # `date` doit etre resolue (bug E81) et presente dans le ctx ET dans la cle.
    assert appel["ctx"]["date"] == "2026-09-01"
    assert appel["key"]["date"] == "2026-09-01"
    assert appel["ctx"]["elo_h"] == 1500 and appel["ctx"]["elo_a"] == 1500


def test_hook_prediction_engine_logue_les_erreurs():
    """E81 : le hook ne doit plus avaler ses exceptions en silence."""
    sys.path.insert(0, str(ROOT / "core"))
    import logging

    import core.prediction_engine as pe

    os.environ["BASELINE_FALLBACK"] = "on"

    def boom(key, ctx, markets=("1x2", "ou25", "btts")):
        raise ValueError("poubelle")

    original = bf.predict_for_match
    bf.predict_for_match = boom
    logger = logging.getLogger("core.prediction_engine")
    captured = []
    handler = logging.Handler()
    handler.emit = lambda rec: captured.append(rec)
    logger.addHandler(handler)
    prev = logger.level
    logger.setLevel(logging.WARNING)
    try:
        out = pe._attach_baseline_fallback(
            {"homeTeam": "Arsenal", "awayTeam": "Chelsea",
             "league": "E0", "date": "2026-09-01"},
            xg_h=1.8, xg_a=1.2,
        )
    finally:
        logger.removeHandler(handler)
        logger.setLevel(prev)
        bf.predict_for_match = original
        os.environ["BASELINE_FALLBACK"] = "off"

    assert out is None, "un echec doit rester non bloquant"
    assert any("poubelle" in r.getMessage() for r in captured), \
        "l'exception doit etre tracee, pas silencieuse"


def test_feature_vector_preserve_les_valeurs_manquantes():
    """E81 : ne pas remplir a 0.0.

    Les bundles LR/RF contiennent un SimpleImputer (median) + StandardScaler.
    Remplir a 0.0 neutralise l'imputer et place des valeurs hors distribution
    (elo=0 au lieu de ~1500). Mesure sur 13176 matchs hors echantillon :
    AUC 0,717 -> 0,731 et pick 40,7 % -> 52,6 %. Ce test verrouille la
    preservation des NaN.
    """
    import math

    feats = ["elo_home", "home_xg", "H_pts_L5"]
    row = {"elo_home": 1700.0, "home_xg": None, "H_pts_L5": float("nan")}
    vec = bf._feature_vector(row, feats)
    assert vec[0] == 1700.0
    assert math.isnan(vec[1]), "None doit devenir NaN (pas 0.0)"
    assert math.isnan(vec[2]), "NaN doit rester NaN (pas 0.0)"
    # Une cle absente est aussi NaN, jamais 0.0.
    assert math.isnan(bf._feature_vector({}, feats)[0])


# --------------------------------------------------------------------------
# E82 : le branchement gar�� du fallback 1X2 sur les probabilites servies
# --------------------------------------------------------------------------

def test_odds_source_python_miroite_le_js():
    """Le predicat Python doit reproduire core/oddsSource.js exactement.

    Les deux langages doivent pouvoir servir les memes matchs : si le JS
    refuse une source que le Python accepte, le garde laisse passer une cote
    synthetique et on retombe dans la confiance absurde mesuree en E82.
    """
    from core.odds_source import is_real_bookmaker_source as py

    faux = [None, "", "  ", "fair_odds_model", "default", "synthetic",
            "model_league", "historical", "historical+elo", "none",
            "non_bookmaker", "non_bookmaker:default", "FAIR_ODDS_MODEL",
            "non_bookmaker:x", "model_anything"]
    for s in faux:
        assert py(s) is False, "%r doit etre rejete" % (s,)
    for s in ["betexplorer", "footballdata", "football_data", "ultimate:2-sources",
              "ultimate:1-sources", "local", "oddsapiio"]:
        assert py(s) is True, "%r doit etre accepte" % (s,)


def test_devig_convertit_les_cotes_en_probabilites():
    """E82 : P*_open_avg est une PROBABILITE a l'entrainement (mediane 0,425),
    pas une cote. Injecter la cote brute sortait le vecteur du domaine d'un
    facteur 5 a 10 et le modele sortait 0,9998 de confiance."""
    from core.baseline_features import _devig

    p = _devig({"P1_open": 2.15, "PX_open": 3.34, "P2_open": 3.03})
    assert abs(sum(p.values()) - 1.0) < 1e-9
    # Ordre respecte : 2.15 < 3.34 -> domicile le plus probable.
    assert p["P1_open"] > p["P2_open"] > p["PX_open"]
    # Ordre de grandeur coherent avec l'entrainement (mediane 0,425 / 0,266 / 0,291).
    assert 0.30 < p["P1_open"] < 0.55
    assert 0.20 < p["PX_open"] < 0.40
    # Entrees invalides -> aucun mapping (les valeurs restent a la mediane).
    assert _devig({"P1_open": 2.0}) == {}
    assert _devig({"P1_open": 1.0, "PX_open": 3.3, "P2_open": 3.0}) == {}
    assert _devig({"P1_open": None, "PX_open": 3.3, "P2_open": 3.0}) == {}


def test_build_accepte_une_date_avec_fuseau():
    """E82 : master_dataset.date est tz-naive. Une date de match tz-aware
    (ISO '...+00:00', cas de tous les matchs stockes en base) faisait echouer
    le chemin ctx sur une TypeError -> le chemin ctx n'a jamais fonctionne."""
    from core import baseline_features as bfs

    ctx = {
        "home_team": "Arsenal", "away_team": "Chelsea",
        "date": "2026-09-01T15:00:00.000Z",
        "elo_h": 1850, "elo_a": 1800, "xg_h": 1.8, "xg_a": 1.2,
        "P1_open": 2.1, "PX_open": 3.4, "P2_open": 3.6,
    }
    feats = bfs.build(ctx)
    assert 0 < feats["P1_open_avg"] < 1, "P*_open_avg est une probabilite"
    assert 0 < feats["H_pts_L5"] <= 3
    assert bfs.teams_known(ctx) is True


def test_teams_known_rejette_les_equipes_absentes():
    from core import baseline_features as bfs

    assert bfs.teams_known(None) is False
    assert bfs.teams_known({"home_team": "X", "away_team": None}) is False
    ctx = {"home_team": "ZZ Unknown Home", "away_team": "ZZ Unknown Away",
           "date": "2026-09-01T15:00:00.000Z"}
    assert bfs.teams_known(ctx) is False


def _wire(m, base=(0.44, 0.28, 0.28)):
    sys.path.insert(0, str(ROOT / "core"))
    import core.prediction_engine as pe

    return pe.apply_baseline_1x2_wire(base[0], base[1], base[2], m, None, None)


def _assert_intact(out, base=(0.44, 0.28, 0.28)):
    assert out[3]["applied"] is False
    assert all(abs(a - b) < 1e-12 for a, b in zip(out[:3], base))


def test_wire_desactive_par_defaut():
    os.environ["BASELINE_1X2_WIRE"] = "off"
    out = _wire({"homeTeam": "Arsenal", "awayTeam": "Chelsea",
                 "date": "2026-09-01", "odds_source": "betexplorer",
                 "odds_home": 2.1, "odds_draw": 3.4, "odds_away": 3.6})
    assert out[3]["reason"] == "kill_switch_off"
    _assert_intact(out)
    os.environ.pop("BASELINE_1X2_WIRE", None)


def test_wire_rejette_les_cotes_synthetiques():
    """Une cote `fair_odds_model` vaut 2.1 > 1.0 : le test `> 1.0` seul ne
    protegeait rien. Le modele nourri de sa propre sortie sortait 0,9998."""
    os.environ["BASELINE_1X2_WIRE"] = "on"
    for src in ("fair_odds_model", "non_bookmaker:default", "default", None):
        out = _wire({"homeTeam": "Arsenal", "awayTeam": "Chelsea",
                     "date": "2026-09-01", "odds_source": src,
                     "odds_home": 2.1, "odds_draw": 3.4, "odds_away": 3.6})
        assert out[3]["reason"] == "source_de_cotes_non_reelle", src
        _assert_intact(out)
    os.environ["BASELINE_1X2_WIRE"] = "off"


def test_wire_rejette_les_equipes_inconnues():
    os.environ["BASELINE_1X2_WIRE"] = "on"
    out = _wire({"homeTeam": "ZZ Inconnus A", "awayTeam": "ZZ Inconnus B",
                 "date": "2026-09-01", "odds_source": "betexplorer",
                 "odds_home": 2.1, "odds_draw": 3.4, "odds_away": 3.6})
    assert out[3]["reason"] == "equipes_inconnues_du_master"
    _assert_intact(out)
    os.environ["BASELINE_1X2_WIRE"] = "off"


def test_wire_rejette_les_cotes_completes_manquantes():
    os.environ["BASELINE_1X2_WIRE"] = "on"
    out = _wire({"homeTeam": "Arsenal", "awayTeam": "Chelsea",
                 "date": "2026-09-01", "odds_source": "betexplorer",
                 "odds_home": 2.1, "odds_draw": None, "odds_away": 3.6})
    assert out[3]["reason"] == "pas_de_cotes_reelles"
    _assert_intact(out)
    os.environ["BASELINE_1X2_WIRE"] = "off"


def test_wire_applique_et_sort_un_triplet_valide():
    """Match eligible : cotes reelles + equipes connues du master."""
    os.environ["BASELINE_1X2_WIRE"] = "on"
    os.environ["BASELINE_1X2_WEIGHT"] = "1.0"
    out = _wire({"homeTeam": "Arsenal", "awayTeam": "Chelsea",
                 "date": "2026-09-01", "odds_source": "betexplorer",
                 "odds_home": 2.1, "odds_draw": 3.4, "odds_away": 3.6})
    assert out[3]["applied"] is True, out[3]
    p = out[:3]
    assert abs(sum(p) - 1) < 1e-6
    assert all(0 <= x <= 1 for x in p)
    assert out[3]["weight"] == 1.0
    # Confiance raisonnable : le modele ne doit pas produire 0,999 sur un
    # simple 2.1 / 3.4 / 3.6 (symptome des variables hors domaine, E82).
    assert max(p) < 0.95, "confiance aberrante : %s" % (p,)
    os.environ["BASELINE_1X2_WIRE"] = "off"


def test_wire_poids_partiel_melange_les_deux_triplets():
    os.environ["BASELINE_1X2_WIRE"] = "on"
    os.environ["BASELINE_1X2_WEIGHT"] = "0.5"
    base = (0.44, 0.28, 0.28)
    out = _wire({"homeTeam": "Arsenal", "awayTeam": "Chelsea",
                 "date": "2026-09-01", "odds_source": "betexplorer",
                 "odds_home": 2.1, "odds_draw": 3.4, "odds_away": 3.6}, base=base)
    assert out[3]["applied"] is True
    assert abs(sum(out[:3]) - 1) < 1e-6
    # A poids 0.5 on doit retrouver la moyenne des deux.
    for got, old, new in zip(out[:3], base, out[3]["probs"]):
        assert abs(got - (0.5 * old + 0.5 * new)) < 2e-3
    os.environ["BASELINE_1X2_WIRE"] = "off"
    os.environ["BASELINE_1X2_WEIGHT"] = "1.0"

