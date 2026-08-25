"""Backtest de paris (value betting) sur les probabilités calibrées OOS.

Rejoue exactement le walk-forward du backtest (TimeSeriesSplit temporel +
calibration isotonique), associe à chaque match OOS ses cotes moyennes réelles
(disponibles pré-match), puis évalue des règles de mise :

  - value > seuil  : parier toute issue où p_modèle × cote − 1 > seuil ;
  - argmax         : parier l'issue la plus probable du modèle ;
  - favori (marché): parier la cote la plus basse (référence vs marge bookmaker).

Variantes de mise : plate 1u (par défaut) et Kelly fractionnaire (cap % du
bankroll). Sorties : ROI, hit-rate, CLV, drawdown, courbe cumulée par saison.

Usage :
    python scripts/bet_backtest.py [--mode full|basic] [--odds] [--splits 5]
                                   [--thresholds 0,0.02,0.05,0.08,0.10]
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import TimeSeriesSplit

ROOT = Path(__file__).resolve().parents[1]
import sys  # noqa: E402
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from config import MASTER_CSV  # noqa: E402
from ml_mapper import prepare  # noqa: E402
from backtest import build_model, calibrate_model  # noqa: E402

REPORTS_DIR = ROOT / "data" / "processed" / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

# issue -> (index classe, clé proba, clé cote)
OUTCOMES = {"H": (2, "ph", "oh"), "D": (1, "pd_", "od"), "A": (0, "pa", "oa")}
ODMAP = {idx: okey for idx, _, okey in OUTCOMES.values()}
PKMAP = {idx: pkey for idx, pkey, _ in OUTCOMES.values()}


def collect_oos(master: pd.DataFrame, mode: str, use_odds: bool, splits: int, seed: int) -> list[dict]:
    X, y, meta = prepare(master, mode=mode, dropna=True, use_odds=use_odds)
    odds = master.loc[meta.index, ["odds_h_avg", "odds_d_avg", "odds_a_avg"]].reset_index(drop=True)
    X = X.reset_index(drop=True)
    y = y.reset_index(drop=True)
    meta = meta.reset_index(drop=True)

    order = np.argsort(meta["date"].to_numpy(), kind="stable")
    X, y, meta, odds = (X.iloc[order].reset_index(drop=True), y.iloc[order].reset_index(drop=True),
                        meta.iloc[order].reset_index(drop=True), odds.iloc[order].reset_index(drop=True))

    rows: list[dict] = []
    tscv = TimeSeriesSplit(n_splits=splits)
    for tr, te in tscv.split(X):
        model = build_model(seed)
        model.fit(X.iloc[tr], y.iloc[tr])
        calibrator = calibrate_model(model, X.iloc[tr], y.iloc[tr], seed)
        proba = calibrator.predict_proba(X.iloc[te])
        for i, gi in enumerate(te):
            rows.append({
                "date": meta.iloc[gi]["date"], "season": meta.iloc[gi]["season"],
                "league": meta.iloc[gi]["league"], "home": meta.iloc[gi]["home_team"],
                "away": meta.iloc[gi]["away_team"],
                "y": int(y.iloc[gi]),
                "ph": proba[i, 2], "pd_": proba[i, 1], "pa": proba[i, 0],
                "oh": float(odds.iloc[gi]["odds_h_avg"]), "od": float(odds.iloc[gi]["odds_d_avg"]),
                "oa": float(odds.iloc[gi]["odds_a_avg"]),
            })
    return rows


def select_threshold(r: dict, thr: float) -> list[tuple[int, float]]:
    out = []
    for idx, pkey, okey in OUTCOMES.values():
        value = r[pkey] * r[okey] - 1
        if value > thr:
            out.append((idx, value))
    return out


def select_argmax(r: dict) -> list[tuple[int, float]]:
    idx, pkey, okey = max(OUTCOMES.values(), key=lambda t: r[t[1]])
    return [(idx, r[pkey] * r[okey] - 1)]


def select_favorite(r: dict) -> list[tuple[int, float]]:
    idx, pkey, okey = min(OUTCOMES.values(), key=lambda t: r[t[2]])
    return [(idx, r[pkey] * r[okey] - 1)]


# Veto Guard / Safety Bracket (miroir du moteur de production) : on saute tout
# pari dont la probabilité modèle >= 0.70 mais le taux de succès historique du
# bracket est < 0.60. Les brackets sont dérivés de l'OOS lui-même (calibration
# empirique du modèle) → permet de vérifier si le filtre améliore le ROI.
GUARD_MIN_PROB = 0.70
GUARD_MAX_HIT = 0.60
GUARD_MIN_SAMPLES = 5


def _bracket_key(prob: float) -> str | None:
    if prob >= 0.90:
        return "90-100"
    if prob >= 0.80:
        return "80-90"
    if prob >= 0.70:
        return "70-80"
    return None


def bracket_hitrate(rows: list[dict]) -> dict:
    """Taux de réussite empirique par bande de probabilité sur les rows OOS."""
    agg: dict[str, dict] = defaultdict(lambda: {"n": 0, "wins": 0})
    for r in rows:
        for idx, pkey, _ in OUTCOMES.values():
            band = _bracket_key(r[pkey])
            if band is None:
                continue
            agg[band]["n"] += 1
            if r["y"] == idx:
                agg[band]["wins"] += 1
    return {b: {"n": a["n"], "hit": a["wins"] / a["n"] if a["n"] else 0.0}
            for b, a in agg.items()}


def evaluate(rows: list[dict], select, kelly: bool = False,
             bankroll: float = 1000.0, kelly_cap: float = 0.05, kelly_frac: float = 0.5,
             guard: bool = False, brackets: dict | None = None) -> list[dict]:
    bets: list[dict] = []
    bal = bankroll
    brackets = brackets or {}
    for r in rows:
        for idx, value in select(r):
            if guard:
                prob = r[PKMAP[idx]]
                band = _bracket_key(prob)
                info = brackets.get(band) if band else None
                if info and info["n"] >= GUARD_MIN_SAMPLES and info["hit"] < GUARD_MAX_HIT:
                    continue  # Veto Guard : bracket trop faible pour prob >= 0.70
            odds = r[ODMAP[idx]]
            if kelly:
                b = odds - 1
                frac = max(0.0, min(1.0, value / b)) if b > 0 else 0.0
                stake = min(bal * frac * kelly_frac, bal * kelly_cap)
                if stake < 0.01:
                    continue
            else:
                stake = 1.0
            win = r["y"] == idx
            ret = stake * odds if win else 0.0
            bal = bal - stake + ret
            bets.append({
                "date": r["date"], "season": r.get("season", "n/a"), "league": r.get("league", "n/a"),
                "home": r.get("home", ""), "away": r.get("away", ""), "y": r["y"],
                "stake": float(stake), "odds": float(odds), "ret": float(ret),
                "value": float(value), "win": bool(win),
            })
    return bets


def summarize(bets: list[dict], bankroll: float = 1000.0) -> dict | None:
    if not bets:
        return None
    staked = sum(b["stake"] for b in bets)
    profit = sum(b["ret"] - b["stake"] for b in bets)
    wins = sum(1 for b in bets if b["win"])
    cum = 0.0
    peak = -float("inf")
    maxdd = 0.0
    for b in bets:
        cum += b["ret"] - b["stake"]
        peak = max(peak, cum)
        maxdd = max(maxdd, peak - cum)
    return {
        "n": len(bets), "wins": wins, "hit_rate": round(wins / len(bets), 4),
        "staked": round(staked, 1), "profit": round(profit, 1), "roi": round(profit / staked, 4),
        "avg_odds": round(float(np.mean([b["odds"] for b in bets])), 3),
        "clv": round(float(np.mean([b["value"] for b in bets])), 4),
        "max_drawdown": round(maxdd, 1), "final_balance": round(bankroll + profit, 1),
    }


def per_season(bets: list[dict]) -> dict:
    agg = defaultdict(lambda: {"n": 0, "wins": 0, "staked": 0.0, "profit": 0.0})
    for b in bets:
        a = agg[str(b["season"])]
        a["n"] += 1
        a["wins"] += int(b["win"])
        a["staked"] += b["stake"]
        a["profit"] += b["ret"] - b["stake"]
    return {
        s: {"n": a["n"], "hit_rate": round(a["wins"] / a["n"], 3) if a["n"] else 0,
            "roi": round(a["profit"] / a["staked"], 4) if a["staked"] else 0}
        for s, a in sorted(agg.items())
    }


def cum_series(bets: list[dict]) -> list[dict]:
    series = []
    cum = 0.0
    for b in sorted(bets, key=lambda b: b["date"]):
        cum += b["ret"] - b["stake"]
        series.append({"date": str(b["date"].date()), "cum_profit": round(cum, 2)})
    return series


def main() -> None:
    parser = argparse.ArgumentParser(description="Backtest de paris value betting")
    parser.add_argument("--mode", choices=["full", "basic"], default="full")
    parser.add_argument("--splits", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--odds", action="store_true", default=True, help="utiliser les cotes implicites (défaut)")
    parser.add_argument("--thresholds", type=str, default="0,0.02,0.05,0.08,0.10",
                        help="seuils de value à tester (virgules)")
    parser.add_argument("--guard", action="store_true", default=False,
                        help="appliquer le Veto Guard (prob>=0.70 et bracket<0.60 -> skip)")
    args = parser.parse_args()
    thresholds = [float(t) for t in args.thresholds.split(",") if t.strip() != ""]

    master = pd.read_csv(MASTER_CSV, parse_dates=["date"])
    print(f"[bet] {len(master)} matchs chargés (mode={args.mode}, odds={args.odds})")
    rows = collect_oos(master, args.mode, args.odds, args.splits, args.seed)
    print(f"[bet] {len(rows)} matchs out-of-sample collectés")

    strategies: dict = {}
    series: dict[str, list] = {}
    brackets = bracket_hitrate(rows)
    print(f"[bet] brackets OOS (Veto Guard): " +
          ", ".join(f"{b}: {a['hit']:.0%} (n={a['n']})" for b, a in sorted(brackets.items())))
    for thr in thresholds:
        bets = evaluate(rows, lambda r, t=thr: select_threshold(r, t))
        label = f"value>={thr:g}"
        strategies[label] = summarize(bets)
        strategies[label]["per_season"] = per_season(bets)
        if thr == 0.05:
            series["value>=0.05"] = cum_series(bets)
        if args.guard:
            bets_g = evaluate(rows, lambda r, t=thr: select_threshold(r, t), guard=True, brackets=brackets)
            label_g = f"value>={thr:g} + guard"
            strategies[label_g] = summarize(bets_g)
            strategies[label_g]["per_season"] = per_season(bets_g)
            if thr == 0.05:
                series["value>=0.05 + guard"] = cum_series(bets_g)

    bets_argmax = evaluate(rows, select_argmax)
    strategies["argmax (modele)"] = summarize(bets_argmax)
    strategies["argmax (modele)"]["per_season"] = per_season(bets_argmax)
    series["argmax"] = cum_series(bets_argmax)
    if args.guard:
        bets_argmax_g = evaluate(rows, select_argmax, guard=True, brackets=brackets)
        strategies["argmax + guard"] = summarize(bets_argmax_g)
        strategies["argmax + guard"]["per_season"] = per_season(bets_argmax_g)
        series["argmax + guard"] = cum_series(bets_argmax_g)

    bets_fav = evaluate(rows, select_favorite)
    strategies["favori (marche)"] = summarize(bets_fav)
    strategies["favori (marche)"]["per_season"] = per_season(bets_fav)
    series["favori"] = cum_series(bets_fav)

    bets_kelly = evaluate(rows, lambda r: select_threshold(r, 0.05), kelly=True)
    strategies["value>=0.05 + Kelly (50%, cap 5%)"] = summarize(bets_kelly)
    strategies["value>=0.05 + Kelly (50%, cap 5%)"]["per_season"] = per_season(bets_kelly)
    series["kelly"] = cum_series(bets_kelly)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": args.mode, "use_odds": args.odds, "splits": args.splits, "seed": args.seed,
        "n_oos": len(rows), "thresholds": thresholds, "guard": args.guard,
        "guard_brackets": brackets,
        "vig_avg": round(float((1 / master[["odds_h_avg", "odds_d_avg", "odds_a_avg"]].astype(float)).sum(axis=1).mean()), 4),
        "strategies": strategies,
    }
    report_path = REPORTS_DIR / f"bet_backtest_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    series_path = REPORTS_DIR / f"bet_backtest_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}_series.csv"
    pd.DataFrame([
        {"strategy": s, **p} for s, pts in series.items() for p in pts
    ]).to_csv(series_path, index=False)

    print("\n===== ROI PAR STRATEGIE (OOS, mise plate 1u sauf mention) =====")
    print(f"{'strategie':<28}{'n':>6}{'hit':>7}{'ROI':>9}{'CLV':>8}{'profit':>9}{'maxDD':>8}")
    for name, m in strategies.items():
        if m is None:
            print(f"{name:<28}{'-':>6}") 
            continue
        print(f"{name:<28}{m['n']:>6}{m['hit_rate']:>7.3f}{m['roi']:>+9.2%}{m['clv']:>+8.4f}{m['profit']:>+9.0f}{m['max_drawdown']:>8.0f}")

    print("\npar saison (ROI) :")
    for name, m in strategies.items():
        if m is None:
            continue
        seas = m.get("per_season", {})
        print(f"  {name:<28}" + " | ".join(f"{s}: {v['roi']:+.1%}" for s, v in seas.items()))

    print(f"\nrapport : {report_path}")
    print(f"series  : {series_path}")


if __name__ == "__main__":
    main()
