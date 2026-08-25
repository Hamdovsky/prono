"""
train_ht.py — Mesure de la probabilite But 1ere mi-temps (O/U 0.5 HT).

Source VERITABLE : archive_football_data (score_home_ht + score_away_ht).
Calcule P(total HT > 0) globalement et par ligue -> data/ht_ratios.json.
Ce ratio remplace le heuristic `mc_ou25 * 0.95` (Q4) et active le pick HT
mesure dans accuracyEngine (Q1) quand il est surfaced en ht_goal_prob.

Usage : python -m core.train_ht
"""
import json
import os
import sqlite3

import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ARCHIVE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "historical_archive.sqlite")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "ht_ratios.json")
LINE = 0.5


def main():
    if not os.path.exists(ARCHIVE):
        print(f"[train_ht] archive introuvable : {ARCHIVE}")
        return
    con = sqlite3.connect(ARCHIVE)
    rows = con.execute(
        "SELECT league_code, score_home_ht, score_away_ht FROM archive_football_data "
        "WHERE score_home_ht IS NOT NULL AND score_away_ht IS NOT NULL"
    ).fetchall()
    con.close()
    n = len(rows)
    if n < 200:
        print(f"[train_ht] echantillon insuffisant ({n}) — abort")
        return

    def over_ht(sh, sa):
        return 1 if (sh + sa) > 0 else 0

    global_over = sum(over_ht(r[1], r[2]) for r in rows)
    by_league = {}
    for league, sh, sa in rows:
        d = by_league.setdefault(league, [0, 0])
        d[0] += 1
        d[1] += over_ht(sh, sa)

    ratios = {
        "line": LINE,
        "n": n,
        "global": round(global_over / n, 4),
        "by_league": {lg: round(c[1] / c[0], 4) for lg, c in by_league.items() if c[0] >= 50},
    }
    with open(OUT, "w") as f:
        json.dump(ratios, f, indent=2)
    print(f"[train_ht] n={n} P(HT Over 0.5) global={ratios['global']:.3f} "
          f"({len(ratios['by_league'])} ligues >=50 matchs)")
    print(f"[train_ht] -> {OUT}")


if __name__ == "__main__":
    main()
