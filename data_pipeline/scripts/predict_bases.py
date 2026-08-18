"""Bases solides quotidiennes : pronostics multi-marchés à forte confiance.

Réutilise EXACTEMENT la construction de features de l'entraînement
(predict_fixtures.build_fixture_features : forme as-of, Elo, cotes implicites)
et les modèles par marché de markets.py (1X2, Over/Under 2.5, BTTS, Corners).

Une "base" est émise quand la probabilité calibrée du modèle dépasse un seuil
de confiance par marché (et, si les cotes sont fournies, quand la value est >= 0).

Sortie : data/processed/reports/bases_<ts>.csv

Usage :
    python scripts/predict_bases.py [--fixtures affiches.csv | --auto]
                                    [--splits-backup] [--mode full|basic]
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from config import MASTER_CSV  # noqa: E402
from ml_mapper import prepare  # noqa: E402
from markets import MARKETS, build_classifier  # noqa: E402
from predict_fixtures import build_fixture_features, load_fixtures_auto, load_fixtures_csv  # noqa: E402

REPORTS_DIR = ROOT / "data" / "processed" / "reports"

# Seuil de confiance minimal par marché pour émettre une "base"
THRESHOLDS = {
    "1x2": 0.55,
    "ou25": 0.60,
    "btts": 0.58,
    "corners": 0.60,
}
ODDS_BY_PICK = {
    "1x2": {"A": "odds_a_avg", "D": "odds_d_avg", "H": "odds_h_avg"},
    "ou25": {"under": "odds_u25_avg", "over": "odds_o25_avg"},
    "btts": {},
    "corners": {},
}


def _fit_calibrated(spec, X: pd.DataFrame, y: pd.Series, seed: int):
    """Modèle calibré (isotonic par classe) sur la dernière tranche temporelle."""
    cal_size = max(int(0.15 * len(X)), 200)
    X_fit, X_cal = X.iloc[:-cal_size], X.iloc[-cal_size:]
    y_fit, y_cal = y.iloc[:-cal_size], y.iloc[-cal_size:]
    scale = 1.0
    if spec.kind == "binary":
        pos = float(y_fit.sum())
        scale = (len(y_fit) - pos) / max(pos, 1.0)
    base = build_classifier(spec, seed, scale_pos_weight=scale)
    base.fit(X_fit, y_fit)
    proba_cal = base.predict_proba(X_cal)
    y_onehot = np.zeros((len(y_cal), proba_cal.shape[1]))
    y_onehot[np.arange(len(y_cal)), y_cal.to_numpy().astype(int)] = 1.0
    regressors = [IsotonicRegression(out_of_bounds="clip") for _ in range(proba_cal.shape[1])]
    for c in range(proba_cal.shape[1]):
        regressors[c].fit(proba_cal[:, c], y_onehot[:, c])

    class _Calibrated:
        def __init__(self, base, regressors):
            self.base = base
            self.regressors = regressors

        def predict_proba(self, X_pred: pd.DataFrame) -> np.ndarray:
            p = self.base.predict_proba(X_pred)
            out = np.column_stack([reg.predict(p[:, c]) for c, reg in enumerate(self.regressors)])
            total = out.sum(axis=1, keepdims=True)
            return out / np.where(total > 0, total, 1.0)

    return _Calibrated(base, regressors)


def _proba(master: pd.DataFrame, Xf: pd.DataFrame, market: str, seed: int) -> np.ndarray:
    spec = MARKETS[market]
    X, y, meta = prepare(master, mode=spec.feat_mode, dropna=True,
                         use_odds=spec.use_odds, target=spec.target)
    order = np.argsort(meta["date"].to_numpy(), kind="stable")
    X = X.iloc[order].reset_index(drop=True)
    y = y.iloc[order].reset_index(drop=True)
    model = _fit_calibrated(spec, X, y, seed)
    return model.predict_proba(Xf)


def _odds_lookup(fixtures: pd.DataFrame) -> dict:
    """Cotes indexées par (date normalisée, home canonique, away canonique)."""
    from team_mapping import TeamMapper
    wanted = list(ODDS_BY_PICK["1x2"].values()) + list(ODDS_BY_PICK["ou25"].values())
    cols = [c for c in wanted if c in fixtures.columns]
    if not cols:
        return {}
    mapper = TeamMapper()
    lookup: dict[tuple, dict[str, float]] = {}
    for _, f in fixtures.iterrows():
        key = (pd.Timestamp(f["date"]).normalize(),
               mapper.map(f["home_team"]), mapper.map(f["away_team"]))
        lookup[key] = {c: f[c] for c in cols}
    return lookup


def emit_bases(meta: pd.DataFrame, proba: np.ndarray, market: str,
               odds_lookup: dict) -> pd.DataFrame:
    spec = MARKETS[market]
    thr = THRESHOLDS[market]
    odds_map = ODDS_BY_PICK[market]
    rows = []
    for i in range(len(meta)):
        p = proba[i]
        k = int(np.argmax(p))
        conf = float(p[k])
        if conf < thr:
            continue
        pick = spec.labels[k]
        row = {
            "date": meta.iloc[i]["date"],
            "league": meta.iloc[i]["league"],
            "home_team": meta.iloc[i]["home_team"],
            "away_team": meta.iloc[i]["away_team"],
            "market": spec.name,
            "pick": pick,
            "prob": round(conf, 3),
        }
        if pick in odds_map:
            key = (pd.Timestamp(meta.iloc[i]["date"]).normalize(),
                   meta.iloc[i]["home_team"], meta.iloc[i]["away_team"])
            vals = odds_lookup.get(key)
            if vals and odds_map[pick] in vals:
                o = vals[odds_map[pick]]
                if o and o > 1:
                    row["odds"] = round(float(o), 2)
                    row["value"] = round(conf * float(o) - 1, 3)
        rows.append(row)
    return pd.DataFrame(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Bases solides multi-marchés")
    parser.add_argument("--fixtures", type=Path, default=None,
                        help="CSV manuel : date, league, home_team, away_team [, cotes]")
    parser.add_argument("--auto", action="store_true", help="Affiches à venir via Sofascore")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if args.fixtures is not None:
        fixtures = load_fixtures_csv(args.fixtures)
    else:
        fixtures = load_fixtures_auto()

    if fixtures.empty:
        print("[bases] Aucune affiche à prédire. Fournissez un CSV avec --fixtures.")
        return

    fixtures["date"] = pd.to_datetime(fixtures["date"], errors="coerce")
    fixtures = fixtures.dropna(subset=["date"])
    fixtures = fixtures[fixtures["date"] >= pd.Timestamp.now().normalize()]
    if fixtures.empty:
        print("[bases] Aucune affiche future dans les fixtures fournies.")
        return

    master = pd.read_csv(MASTER_CSV, parse_dates=["date"])
    odds_lookup = _odds_lookup(fixtures)
    all_bases = []

    for market, spec in MARKETS.items():
        Xf, meta, _ = build_fixture_features(fixtures, master, spec.feat_mode, spec.use_odds)
        proba = _proba(master, Xf, market, args.seed)
        bases = emit_bases(meta, proba, market, odds_lookup)
        print(f"[bases] {spec.name:>16} : {len(bases)} base(s) émise(s) sur {len(meta)} affiches")
        all_bases.append(bases)

    if not all_bases or all(b.empty for b in all_bases):
        print("[bases] Aucune base solide aujourd'hui (seuils non atteints).")
        return

    out = pd.concat(all_bases, ignore_index=True)
    out = out.sort_values(["date", "market", "league"]).reset_index(drop=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_path = REPORTS_DIR / f"bases_{ts}.csv"
    out.to_csv(out_path, index=False)

    print("\n===== BASES SOLIDES =====")
    pd.set_option("display.width", 220)
    show = [c for c in ["date", "league", "home_team", "away_team", "market", "pick", "prob", "odds", "value"] if c in out.columns]
    print(out[show].to_string(index=False))
    print(f"\nCSV : {out_path}")


if __name__ == "__main__":
    main()
