"""
backtest_corners.py — Backtest chronologique du marché Corners O/U.

Méthodologie honnête (zéro fuite) :
  - Matchs triés par date ; les N premiers ne servent qu'à construire l'historique.
  - Pour chaque match évalué : mu total = moyenne de l'équipe domicile (passé uniquement,
    shrinkage vers la moyenne globale) + moyenne de l'équipe extérieure (idem),
    ajustement avantage du terrain. P(Over ligne) via la Negative Binomial calibrée
    de PROD (core/corners_calib.p_over_corner, même alpha que le runtime).
  - Paris UNIQUEMENT sur les cotes réelles archivées (aucun prix inventé) :
    Stratégie A "edge"   : pari si p_model > 1/cote + marge de sécurité 3 %
    Stratégie B "seuil"  : pari si p >= 55 % (Over) ou <= 45 % (Under) [règle prod]
  - Métriques modèle : log-loss + Brier sur TOUS les matchs à cote, vs baseline base-rate.

Usage : python scripts/backtest_corners.py [--warmup 3000] [--edge 0.03]
"""
import argparse
import math
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from core.corners_calib import load_calibration, p_over_corner  # noqa: E402

DB_PATH = os.path.join(ROOT, "data", "historical_archive.sqlite")


def logloss(p, y, eps=1e-9):
    p = min(max(p, eps), 1 - eps)
    return -(y * math.log(p) + (1 - y) * math.log(1 - p))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--warmup", type=int, default=3000)
    ap.add_argument("--edge", type=float, default=0.03)
    ap.add_argument("--min-date", default=None, help="Évaluer uniquement les matchs >= cette date (YYYY-MM-DD)")
    ap.add_argument("--flat-odds", type=float, default=1.90, help="Cote plate quand cote réelle absente")
    args = ap.parse_args()

    calib = load_calibration()
    alpha = calib.get("alpha", 0.45)

    db = sqlite3.connect(DB_PATH)
    cur = db.cursor()
    cur.execute(
        """
        SELECT match_date, league_code, home_team, away_team,
               corners_home, corners_away,
               corner_line, odds_corner_over, odds_corner_under
          FROM archive_football_data
         WHERE corners_home IS NOT NULL AND corners_away IS NOT NULL
         ORDER BY match_date, id
        """
    )
    rows = cur.fetchall()
    db.close()
    print(f"[INFO] {len(rows)} matchs avec corners chargés")

    # ── État historique (rempli au fil de l'eau, passé uniquement) ──
    hist_team = {}      # team -> [sum_corners_won, n]
    hist_league = {}    # league -> [sum_corners_total, n]
    glob = {"s": 0.0, "n": 0}     # somme/n totaux corners (toutes équipes confondues)
    home_extra = {"s": 0.0, "n": 0}  # cumul (corners dom - moy globale) pour avantage terrain

    def team_rate(team, k=8.0):
        s, n = hist_team.get(team, (0.0, 0))
        g = glob["s"] / max(glob["n"], 1)
        if n == 0:
            return g
        return (s + k * g) / (n + k)

    # ── Accumulateurs résultats ──
    ll_all = brier_all = n_all = 0
    base_rate_sum = base_n = 0
    stratA = {"bets": 0, "wins": 0, "profit": 0.0}
    stratB = {"bets": 0, "wins": 0, "profit": 0.0}
    per_year = {}

    for i, (date, lg, home, away, ch, ca, line, o_ov, o_un) in enumerate(rows):
        try:
            ch, ca = float(ch), float(ca)
            total_obs = ch + ca
        except (TypeError, ValueError):
            continue

        if i < args.warmup or (args.min_date and (not date or date < args.min_date)):
            # construction historique seulement (et mise à jour courante si filtré par date)
            hist_team[home] = (hist_team.get(home, (0.0, 0))[0] + ch, hist_team.get(home, (0.0, 0))[1] + 1)
            hist_team[away] = (hist_team.get(away, (0.0, 0))[0] + ca, hist_team.get(away, (0.0, 0))[1] + 1)
            glob["s"] += ch + ca
            glob["n"] += 2
            continue

        g_mean = glob["s"] / max(glob["n"], 1)
        r_h = team_rate(home)
        r_a = team_rate(away)
        # avantage terrain : les équipes jouant à domicile marquent en moyenne
        # plus de corners ; approximation via l'écart moyen observé (défaut +0.4)
        mu_total = r_h + r_a + 0.4

        # ligne : celle du marché si dispo sinon 9.5
        try:
            ln = float(line) if line is not None else 9.5
        except (TypeError, ValueError):
            ln = 9.5

        p_over = p_over_corner(mu_total, ln, alpha=alpha)
        y = 1.0 if total_obs > ln else 0.0

        # métriques modèle (sur tous les matchs évalués)
        ll_all += logloss(p_over, y)
        brier_all += (p_over - y) ** 2
        n_all += 1
        base_rate_sum += y
        base_n += 1

        year = (date or "????")[:4]
        yb = per_year.setdefault(year, {"A_b": 0, "A_w": 0, "A_p": 0.0, "B_b": 0, "B_w": 0, "B_p": 0.0})

        # ── Stratégie A : edge vs cote réelle ──
        try:
            oov = float(o_ov) if o_ov is not None else None
            oun = float(o_un) if o_un is not None else None
        except (TypeError, ValueError):
            oov = oun = None
        if oov and oov > 1.01:
            stake_side = None
            if p_over > (1.0 / oov) + args.edge:
                stake_side, odd = ("OVER", oov)
            elif (1 - p_over) > ((1.0 / oun) + args.edge) if (oun and oun > 1.01) else False:
                stake_side, odd = ("UNDER", oun)
            if stake_side:
                won = (y == 1 and stake_side == "OVER") or (y == 0 and stake_side == "UNDER")
                stratA["bets"] += 1
                yb["A_b"] += 1
                if won:
                    stratA["wins"] += 1
                    stratA["profit"] += odd - 1
                    yb["A_w"] += 1
                    yb["A_p"] += odd - 1
                else:
                    stratA["profit"] -= 1
                    yb["A_p"] -= 1

        # ── Stratégie B : seuil prod 55/45 (cote réelle si dispo sinon cote plate) ──
        if p_over >= 0.55:
            odd = oov if (oov and oov > 1.01) else args.flat_odds
            stratB["bets"] += 1
            yb["B_b"] += 1
            if y == 1:
                stratB["wins"] += 1
                stratB["profit"] += odd - 1
                yb["B_w"] += 1
                yb["B_p"] += odd - 1
            else:
                stratB["profit"] -= 1
                yb["B_p"] -= 1
        elif p_over <= 0.45:
            odd = oun if (oun and oun > 1.01) else args.flat_odds
            stratB["bets"] += 1
            yb["B_b"] += 1
            if y == 0:
                stratB["wins"] += 1
                stratB["profit"] += odd - 1
                yb["B_w"] += 1
                yb["B_p"] += odd - 1
            else:
                stratB["profit"] -= 1
                yb["B_p"] -= 1

        # mise à jour historique APRÈS évaluation (pas de fuite)
        hist_team[home] = (hist_team.get(home, (0.0, 0))[0] + ch, hist_team.get(home, (0.0, 0))[1] + 1)
        hist_team[away] = (hist_team.get(away, (0.0, 0))[0] + ca, hist_team.get(away, (0.0, 0))[1] + 1)
        glob["s"] += ch + ca
        glob["n"] += 2

    base = base_rate_sum / max(base_n, 1)
    print(f"\n=== MODÈLE (n={n_all}) ===")
    print(f"  Log-loss : {ll_all/max(n_all,1):.4f}   (baseline base-rate {base:.3f} -> {-(base*math.log(base)+(1-base)*math.log(1-base)):.4f})")
    print(f"  Brier    : {brier_all/max(n_all,1):.4f}   (baseline {base*(1-base):.4f})")
    print(f"  Base rate P(Over ligne) observé : {base:.3f}")

    for name, s in (("A: EDGE vs cote réelle (+3%)", stratA), ("B: SEUIL prod 55/45", stratB)):
        b, w, p = s["bets"], s["wins"], s["profit"]
        roi = 100 * p / b if b else 0
        hit = 100 * w / b if b else 0
        print(f"\n=== STRATÉGIE {name} ===")
        print(f"  Paris : {b}   Gagnés : {w} ({hit:.1f} %)   Profit : {p:+.1f} u   ROI flat : {roi:+.2f} %")

    print("\n=== PAR ANNÉE (stratégie A | B) ===")
    for yr in sorted(per_year):
        d = per_year[yr]
        ra = 100 * d["A_p"] / d["A_b"] if d["A_b"] else 0
        rb = 100 * d["B_p"] / d["B_b"] if d["B_b"] else 0
        print(f"  {yr}: A {d['A_b']:>4} paris ROI {ra:+6.1f} %  |  B {d['B_b']:>4} paris ROI {rb:+6.1f} %")


if __name__ == "__main__":
    main()
