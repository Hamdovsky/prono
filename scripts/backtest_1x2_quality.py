"""
backtest_1x2_quality.py — 1X2 PUR basé qualité d'équipe vs VRAIES cotes archivées.

Prédicteur : forces attaque/défense par équipe et par ligue (shrinkage k=3),
modèle Poisson score-grid — le même moteur que core/backtest_walkforward.py.
Zéro fuite : fenêtre chronologique, refit périodique sur le passé uniquement.

Paris : edge vs cote réelle — on mise l'issue dont p_modèle > 1/cote + marge.
Sorties : ROI global, par année, ère moderne (2020+), log-loss vs base-rate.

Usage : python scripts/backtest_1x2_quality.py [--warmup 3000] [--margin 0.03] [--min-date 2020-01-01]
"""
import argparse
import math
import os
import sqlite3
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from core.backtest_walkforward import poisson_params, poisson_predict  # noqa: E402

DB_PATH = os.path.join(ROOT, "data", "historical_archive.sqlite")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--warmup", type=int, default=3000)
    ap.add_argument("--margin", type=float, default=0.03)
    ap.add_argument("--refit-every", type=int, default=2000)
    ap.add_argument("--min-date", default=None)
    args = ap.parse_args()

    db = sqlite3.connect(DB_PATH)
    df = pd.read_sql_query(
        """
        SELECT match_date AS date, league_code AS league, home_team, away_team,
               score_home AS fthg, score_away AS ftag,
               odds_home AS oh, odds_draw AS od, odds_away AS oa
          FROM archive_football_data
         WHERE odds_home IS NOT NULL AND odds_draw IS NOT NULL AND odds_away IS NOT NULL
           AND score_home IS NOT NULL AND score_away IS NOT NULL
         ORDER BY match_date, id
        """,
        db,
    )
    db.close()
    for c in ("oh", "od", "oa"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["oh", "od", "oa"]).reset_index(drop=True)
    print(f"[INFO] {len(df)} matchs avec cotes 1X2 + scores")

    params = None
    last_fit = -10**9
    stats = {"bets": 0, "wins": 0, "profit": 0.0}
    recent = {"bets": 0, "wins": 0, "profit": 0.0}
    per_year = {}
    ll = brier = n_eval = 0
    base_h = base_d = base_a = 0

    def bet(odds_vec, probs, y_idx, date):
        edges = []
        for i in range(3):
            o = odds_vec[i]
            if o and o > 1.01:
                edges.append((probs[i] - (1.0 / o) * (1 + args.margin), i, o))
        if not edges:
            return
        edge, i, o = max(edges, key=lambda x: x[0])
        if edge <= 0:
            return
        buckets = [stats, per_year.setdefault(date[:4], {"bets": 0, "wins": 0, "profit": 0.0})]
        if args.min_date and date >= args.min_date:
            buckets.append(recent)
        for bucket in buckets:
            bucket["bets"] += 1
            if i == y_idx:
                bucket["wins"] += 1
                bucket["profit"] += o - 1
            else:
                bucket["profit"] -= 1

    for start in range(args.warmup, len(df)):
        if params is None or start - last_fit >= args.refit_every:
            params = poisson_params(df.iloc[:start])
            last_fit = start
        r = df.iloc[start]
        sub = df.iloc[start : start + 1]
        probs = poisson_predict(params, sub, "1x2")[0]
        y_idx = 0 if r["fthg"] > r["ftag"] else (1 if r["fthg"] == r["ftag"] else 2)

        date = str(r["date"])
        ll += -(math.log(max(probs[y_idx], 1e-9)))
        brier += sum((probs[i] - (1 if i == y_idx else 0)) ** 2 for i in range(3))
        n_eval += 1
        if r["fthg"] > r["ftag"]:
            base_h += 1
        elif r["fthg"] == r["ftag"]:
            base_d += 1
        else:
            base_a += 1

        bet([r["oh"], r["od"], r["oa"]], probs, y_idx, date)

    n = max(n_eval, 1)
    tot = base_h + base_d + base_a
    print(f"\n=== MODÈLE (n={n_eval}) ===")
    print(f"  Log-loss : {ll/n:.4f}")
    print(f"  Brier    : {brier/n:.4f}")
    print(f"  Base rates réels : H {(base_h/tot)*100:.1f}%  D {(base_d/tot)*100:.1f}%  A {(base_a/tot)*100:.1f}%")

    def show(label, s):
        roi = 100 * s["profit"] / s["bets"] if s["bets"] else 0.0
        hit = 100 * s["wins"] / s["bets"] if s["bets"] else 0.0
        print(f"{label:<28} {s['bets']:>6} paris | hit {hit:5.1f}% | P&L {s['profit']:+9.1f}u | ROI {roi:+6.2f}%")

    print("\n=== STRATÉGIE EDGE (p > 1/cote + 3%) ===")
    show("GLOBAL (toutes dates)", stats)
    if args.min_date:
        show(f"ÈRE MODERNE (>={args.min_date})", recent)
    print("\n=== PAR ANNÉE ===")
    for yr in sorted(per_year):
        show(yr, per_year[yr])


if __name__ == "__main__":
    main()
