"""Prédiction 1X2 des matchs à venir + détection de valeur.

Réutilise EXACTEMENT la même construction de features que l'entraînement :
  - forme roulante as-of par équipe (dernier match STRICTEMENT antérieur au
    match à prédire), reprise du master_dataset ;
  - Elo as-of (celui du master) ;
  - cotes implicites si fournies (CSV manuel) ;
  - modèle XGBoost retrainé à jour + calibration isotonique (comme le backtest).

Sources de fixtures :
  --fixtures fichier.csv  : CSV manuel (date, league, home_team, away_team,
                            [odds_h_avg, odds_d_avg, odds_a_avg]) ;
  --auto (défaut)         : affiches à venir de la saison en cours via
                            Sofascore (soccerdata), repli Understat.

Usage :
    python scripts/predict_fixtures.py [--auto | --fixtures affiches.csv]
                                       [--mode full|basic]
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from config import LEAGUES, MASTER_CSV  # noqa: E402
from sources.fbref import fetch_schedule  # noqa: E402
from ml_mapper import BASIC_ROLLING, ADV_ROLLING, ODDS_FEATURES, feature_names, prepare  # noqa: E402
from backtest import CLASS_LABELS, calibrate_model  # noqa: E402
from team_mapping import TeamMapper  # noqa: E402

REPORTS_DIR = ROOT / "data" / "processed" / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

# Cotes réelles des matchs à venir (football-data.co.uk/fixtures.csv), écrites
# par sources/football_data.py:fetch_fixtures() lors du quotidien.
FOOTBALL_DATA_ODDS_CSV = ROOT / "data" / "raw" / "football_data_fixtures.csv"
ODDS_COLS = ("odds_h_avg", "odds_d_avg", "odds_a_avg")

# Features roulantes "nues" (sans préfixe H_/A_) par équipe
BARE_FEATS = [f"{m}_L{w}" for m in BASIC_ROLLING + ADV_ROLLING for w in (5, 10)]
# Correspondance clé pipeline <-> nom soccerdata/Understat
KEY_TO_NAME = {k: v["name"] for k, v in LEAGUES.items()}


def parse_date(s) -> pd.Timestamp | None:
    if isinstance(s, (pd.Timestamp, np.datetime64)):
        return pd.Timestamp(s)
    try:
        return pd.to_datetime(s, format="ISO8601", errors="raise")
    except (ValueError, TypeError):
        pass
    try:
        return pd.to_datetime(s, dayfirst=True, errors="raise")
    except (ValueError, TypeError):
        return None


def _asof(grouped: dict, team: str, ts_ns: int) -> dict | None:
    """Valeurs de features d'une équipe au dernier match strictement < date."""
    g = grouped.get(team)
    if g is None:
        return None
    dates, values = g
    idx = int(np.searchsorted(dates, ts_ns, side="right") - 1)
    return values[idx] if idx >= 0 else None


def load_fixtures_csv(path: Path) -> pd.DataFrame:
    raw = pd.read_csv(path)
    raw["date"] = raw["date"].map(parse_date)
    raw = raw.dropna(subset=["date"]).copy()
    for col in ("league", "home_team", "away_team"):
        if col not in raw.columns:
            raise SystemExit(f"Colonne manquante dans {path} : '{col}'")
    raw["league"] = raw["league"].astype(str).map(lambda v: KEY_TO_NAME.get(v, v))
    return raw


def load_fixtures_auto() -> pd.DataFrame:
    """Fixtures saison en cours via Sofascore (repli Understat)."""
    out = []
    for key, cfg in LEAGUES.items():
        sched = fetch_schedule(leagues={key: cfg})
        if sched is None or sched.empty:
            continue
        sched = sched[sched["date"].notna() & sched["home_team"].ne("") & sched["away_team"].ne("")]
        if "home_score" in sched.columns:
            sched = sched[sched["home_score"].isna()]
        cols = [c for c in ("date", "home_team", "away_team") if c in sched.columns]
        sched = sched[cols].copy()
        sched["league"] = cfg["name"]
        out.append(sched)
    if not out:
        return pd.DataFrame()
    df = pd.concat(out, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    return df


def load_football_data_odds(path: Path | None = None) -> pd.DataFrame:
    """Cotes 1X2 réelles des affiches à venir (football-data fixtures CSV).

    Retourne un DataFrame (date, home_team, away_team, odds_h_avg,
    odds_d_avg, odds_a_avg) aligné sur la journée calendaire, vide si le
    fichier est absent ou sans cotes exploitables.
    """
    path = path or FOOTBALL_DATA_ODDS_CSV
    if not path.exists():
        return pd.DataFrame()
    df = pd.read_csv(path)
    if not all(c in df.columns for c in ("date", "home_team", "away_team") + ODDS_COLS):
        return pd.DataFrame()
    df = df[["date", "home_team", "away_team"] + list(ODDS_COLS)].copy()
    df["date"] = df["date"].map(parse_date)
    df = df.dropna(subset=["date"])
    df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.tz_localize(None).dt.floor("D")
    df = df[df[list(ODDS_COLS)].notna().all(axis=1)]
    return df.drop_duplicates(subset=["date", "home_team", "away_team"], keep="first")


def merge_odds(fixtures: pd.DataFrame, odds: pd.DataFrame) -> pd.DataFrame:
    """Fusionne les cotes réelles sur les affiches auto (mode --auto).

    Alignement sur (date, équipe domicile, équipe extérieure) via le TeamMapper,
    exactement la même normalisation que build_fixture_features. Les affiches
    sans cotes gardent des NaN : le modèle XGBoost les gère en features manquantes.
    """
    if odds is None or odds.empty:
        out = fixtures.copy()
        for col in ODDS_COLS:
            out[col] = float("nan")
        return out

    mapper = TeamMapper()
    fx = fixtures.copy()
    fx["date"] = pd.to_datetime(fx["date"], errors="coerce").dt.tz_localize(None).dt.floor("D")
    fx["_home_m"] = fx["home_team"].map(mapper.map)
    fx["_away_m"] = fx["away_team"].map(mapper.map)

    od = odds.copy()
    od["_home_m"] = od["home_team"].map(mapper.map)
    od["_away_m"] = od["away_team"].map(mapper.map)

    merged = fx.merge(
        od[["date", "_home_m", "_away_m"] + list(ODDS_COLS)],
        on=["date", "_home_m", "_away_m"],
        how="left",
    )
    merged = merged.drop(columns=["_home_m", "_away_m"])
    return merged


def build_team_form(master: pd.DataFrame) -> dict:
    """Dict équipe -> (dates int64 ns, matrice de features nues)."""
    parts = []
    for prefix, teamcol, elo_col in (("H", "home_team", "elo_home"), ("A", "away_team", "elo_away")):
        cols = ["date", teamcol, elo_col] + [f"{prefix}_{b}" for b in BARE_FEATS]
        rename = {teamcol: "team", elo_col: "elo", **{f"{prefix}_{b}": b for b in BARE_FEATS}}
        sub = master[cols].rename(columns=rename).copy()
        parts.append(sub)
    form = pd.concat(parts, ignore_index=True).dropna(subset=["team"])
    form = form.drop_duplicates(["date", "team"], keep="last").sort_values("date")
    grouped: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    feat_cols = ["elo"] + BARE_FEATS
    for team, arr in form.groupby("team"):
        grouped[team] = (
            arr["date"].astype("int64").to_numpy(),
            arr[feat_cols].to_numpy(dtype=float),
        )
    return grouped


def implied_probs(odds_row: pd.Series) -> dict[str, float]:
    inv = 1.0 / odds_row[["odds_h_avg", "odds_d_avg", "odds_a_avg"]].astype(float)
    norm = inv / inv.sum()
    return dict(zip(ODDS_FEATURES, norm))


def build_fixture_features(fixtures: pd.DataFrame, master: pd.DataFrame,
                           mode: str, use_odds: bool) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    grouped = build_team_form(master)
    mapper = TeamMapper()
    feats = feature_names(mode, use_odds)
    rows = []

    for _, fx in fixtures.iterrows():
        home = mapper.map(fx["home_team"])
        away = mapper.map(fx["away_team"])
        ts = int(pd.Timestamp(fx["date"]).to_datetime64().astype("int64"))
        fh = _asof(grouped, home, ts)
        fa = _asof(grouped, away, ts)
        if fh is None or fa is None:
            print(f"[predict] Équipe sans historique, affiche ignorée : {home} - {away}")
            continue

        row = np.full(len(feats), np.nan)
        for pos, name in enumerate(feats):
            if name == "elo_home":
                row[pos] = fh[0]
            elif name == "elo_away":
                row[pos] = fa[0]
            elif name == "F_Elo_Diff":
                row[pos] = fh[0] - fa[0]
            elif name == "Total_xG_L5":
                row[pos] = fh[1 + BARE_FEATS.index("xg_L5")] + fa[1 + BARE_FEATS.index("xg_L5")]
            elif name == "Form_Diff_L5":
                row[pos] = fh[1 + BARE_FEATS.index("pts_L5")] - fa[1 + BARE_FEATS.index("pts_L5")]
            elif name.startswith(("H_", "A_")):
                bare = name[2:]
                if bare in BARE_FEATS:
                    src = fh if name.startswith("H_") else fa
                    row[pos] = src[1 + BARE_FEATS.index(bare)]
            elif name in ODDS_FEATURES and use_odds:
                if fx.get("odds_h_avg") is not None and fx.get("odds_d_avg") is not None and fx.get("odds_a_avg") is not None:
                    row[pos] = implied_probs(fx)[name]

        odds = (fx.get("odds_h_avg", np.nan), fx.get("odds_d_avg", np.nan), fx.get("odds_a_avg", np.nan))
        rows.append((fx["date"], fx["league"], home, away, row, odds))

    if not rows:
        raise SystemExit("[predict] Aucune affiche prédictible.")
    X = pd.DataFrame([r[4] for r in rows], columns=feats)
    meta = pd.DataFrame([r[:4] for r in rows], columns=["date", "league", "home_team", "away_team"])
    meta["season"] = "current"
    odds_out = pd.DataFrame([r[5] for r in rows], columns=["odds_h_avg", "odds_d_avg", "odds_a_avg"])
    return X, meta, odds_out


def main() -> None:
    parser = argparse.ArgumentParser(description="Prédiction 1X2 des matchs à venir")
    parser.add_argument("--fixtures", type=Path, default=None,
                        help="CSV manuel : date, league, home_team, away_team [, odds_h_avg, odds_d_avg, odds_a_avg]")
    parser.add_argument("--auto", action="store_true", help="Affiches à venir via Sofascore (défaut si pas de --fixtures)")
    parser.add_argument("--mode", choices=["full", "basic"], default="full")
    args = parser.parse_args()

    if args.fixtures is not None:
        fixtures = load_fixtures_csv(args.fixtures)
    else:
        fixtures = load_fixtures_auto()

    if fixtures.empty:
        print("[predict] Aucune affiche à prédire (saison en cours non publiée).")
        print("[predict] Fournissez un CSV avec --fixtures (date, league, home_team, away_team [, cotes]).")
        return

    fixtures["date"] = pd.to_datetime(fixtures["date"], errors="coerce").dt.tz_localize(None).dt.floor("D")
    fixtures = fixtures.dropna(subset=["date"])
    fixtures = fixtures[fixtures["date"] >= pd.Timestamp.now().normalize()]
    if fixtures.empty:
        print("[predict] Aucune affiche future dans les fixtures fournies.")
        return

    # Mode --auto : fusionne les cotes réelles football-data (best-effort) pour
    # activer les features cotes et la détection de valeur sur les affiches couvertes.
    if args.fixtures is None:
        odds = load_football_data_odds()
        if not odds.empty:
            before = len(fixtures)
            fixtures = merge_odds(fixtures, odds)
            n_merged = int(fixtures[list(ODDS_COLS)].notna().all(axis=1).sum())
            print(f"[predict] Cotes football-data fusionnées : {n_merged}/{before} affiches")

    has_odds = all(c in fixtures.columns for c in ODDS_COLS)
    n_odds = int(fixtures[list(ODDS_COLS)].notna().all(axis=1).sum()) if has_odds else 0
    # Le modèle garde les features cotes dès qu'au moins une affiche en a ; les
    # autres reçoivent NaN (géré par XGBoost). La valeur n'est calculée que là où
    # des cotes existent.
    use_odds = has_odds and n_odds > 0
    if not has_odds:
        print("[predict] Pas de cotes fournies : prédiction sans features cotes.")
    elif n_odds < len(fixtures):
        print(
            f"[predict] Cotes partielles ({n_odds}/{len(fixtures)}) : features cotes actives, "
            f"valeur calculée uniquement sur les affiches avec cotes."
        )

    print(f"[predict] {len(fixtures)} affiches (mode={args.mode}, odds={use_odds})")

    master = pd.read_csv(MASTER_CSV, parse_dates=["date"])
    X, y, meta_train = prepare(master, mode=args.mode, dropna=True, use_odds=use_odds)
    order = np.argsort(meta_train["date"].to_numpy(), kind="stable")
    X = X.iloc[order].reset_index(drop=True)
    y = y.iloc[order].reset_index(drop=True)
    print(f"[predict] Modèle : {len(X)} matchs d'entraînement, {X.shape[1]} features")
    model = calibrate_model(None, X, y, seed=42)

    Xf, meta, odds = build_fixture_features(fixtures, master, args.mode, use_odds)
    proba = model.predict_proba(Xf)
    pred = np.argmax(proba, axis=1)

    out = meta.copy()
    out["prob_home"] = proba[:, 2].round(4)
    out["prob_draw"] = proba[:, 1].round(4)
    out["prob_away"] = proba[:, 0].round(4)
    out["prediction"] = [CLASS_LABELS[p] for p in pred]
    out["confidence"] = proba.max(axis=1).round(4)
    if use_odds:
        for key, dcol in {"H": "prob_home", "D": "prob_draw", "A": "prob_away"}.items():
            o = odds[f"odds_{key.lower()}_avg"].to_numpy()
            out[f"odds_{key.lower()}"] = o.round(4)
            out[f"value_{key.lower()}"] = (out[dcol] * o - 1).round(4)

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_path = REPORTS_DIR / f"predictions_{ts}.csv"
    out.to_csv(out_path, index=False)

    print("\n===== PREDICTIONS 1X2 =====")
    show = ["date", "league", "home_team", "away_team", "prob_home", "prob_draw", "prob_away", "prediction", "confidence"]
    if "value_h" in out.columns:
        show += ["value_h", "value_d", "value_a"]
    pd.set_option("display.width", 200)
    pd.set_option("display.max_rows", 60)
    print(out[show].to_string(index=False))
    print(f"\nCSV : {out_path}")


if __name__ == "__main__":
    main()
