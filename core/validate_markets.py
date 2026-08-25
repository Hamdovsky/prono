"""
validate_markets.py — Validation adoption Q3/Q5 sur holdout chronologique.

Compare sur les 20 % derniers matchs de l'archive (par date) la justesse des
PICKS BTTS / O/U 2.5 entre :
  - modele logistique calibre (core.btts_model / core.ou_model)
  - heuristique legacy (xg*xg*30+40 / MC brut sur xG Poisson)
Objectif : decider l'activation des gates BTTS_MODEL_ENABLED / OU_MODEL_ENABLED.

Usage : python -m core.validate_markets
"""
import json
import math
import os
import sqlite3

import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.btts_model import btts_prob
from core.ou_model import ou_prob

ARCHIVE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "historical_archive.sqlite")


def poisson_over(total_xg, line):
    """P(Total buts > line) via Poisson(total_xg) — proxy MC legacy O/U."""
    # P(X<=line) = sum_{k=0}^{floor(line)} e^-mu mu^k/k!
    mu = total_xg
    s = 0.0
    for k in range(0, int(math.floor(line)) + 1):
        s += math.exp(-mu) * (mu ** k) / math.factorial(k)
    return 1.0 - s


def main():
    con = sqlite3.connect(ARCHIVE)
    rows = con.execute(
        "SELECT match_date, score_home, score_away, xg_home, xg_away "
        "FROM archive_football_data WHERE xg_home IS NOT NULL AND xg_away IS NOT NULL "
        "AND score_home IS NOT NULL AND score_away IS NOT NULL "
        "ORDER BY match_date ASC"
    ).fetchall()
    con.close()
    n = len(rows)
    if n < 1000:
        print("[validate_markets] echantillon insuffisant")
        return
    cut = int(n * 0.8)
    test = rows[cut:]

    # BTTS
    btts_model_ok = btts_legacy_ok = 0
    btts_model_thr_ok = btts_legacy_thr_ok = 0
    # O/U 2.5
    ou_model_ok = ou_legacy_ok = 0

    for date, sh, sa, xh, xa in test:
        btts = 1 if (sh or 0) > 0 and (sa or 0) > 0 else 0
        total = float(xh) + float(xa)
        over25 = 1 if (sh or 0) + (sa or 0) > 2.5 else 0

        # BTTS : modele (seuil 0.5) vs heuristique legacy (seuil 0.5)
        pmod = btts_prob(xh, xa)
        pleg = min(0.88, (float(xh) * float(xa)) * 30 + 40) / 100.0
        btts_model_ok += 1 if (pmod >= 0.5) == bool(btts) else 0
        btts_legacy_ok += 1 if (pleg >= 0.5) == bool(btts) else 0
        # seuil 0.55 (comme emission)
        btts_model_thr_ok += 1 if (pmod >= 0.55) == bool(btts) else 0
        btts_legacy_thr_ok += 1 if (pleg >= 0.55) == bool(btts) else 0

        # O/U 2.5 : modele vs Poisson MC legacy
        pomod = ou_prob(total, 2.5) or 0.5
        poleg = poisson_over(total, 2.5)
        ou_model_ok += 1 if (pomod >= 0.5) == bool(over25) else 0
        ou_legacy_ok += 1 if (poleg >= 0.5) == bool(over25) else 0

    nt = len(test)
    print(f"[validate_markets] holdout n={nt} (20% derniers, chronologique)")
    print(f"  BTTS  pick@0.5  modele={btts_model_ok/nt:.3f}  legacy={btts_legacy_ok/nt:.3f}")
    print(f"  BTTS  pick@0.55 modele={btts_model_thr_ok/nt:.3f}  legacy={btts_legacy_thr_ok/nt:.3f}")
    print(f"  O/U2.5 pick@0.5  modele={ou_model_ok/nt:.3f}  legacy(Poisson)={ou_legacy_ok/nt:.3f}")
    print("[validate_markets] -> modele bat legacy sur BTTS ?", btts_model_ok >= btts_legacy_ok)
    print("[validate_markets] -> modele bat legacy sur O/U2.5 ?", ou_model_ok >= ou_legacy_ok)


if __name__ == "__main__":
    main()
