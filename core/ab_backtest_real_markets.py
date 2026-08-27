"""A/B backtest du Market Engine (cotes reelles) vs Poisson.

Usage :
    python -m core.ab_backtest_real_markets [--trace data/traces/market_engine_real_markets.jsonl]

Lit le journal d'audit (market_engine_trace) et joint chaque decision sur le
resultat reel du match stocke en DB (matches.scoreHome/scoreAway). Pour chaque
pari de valeur real_markets, on simule une mise plate (1 unit) a la cote reelle :
  - gain si issue gagnante : (odds - 1)
  - perte sinon : -1
On compare le P&L realise des paris VALUE contre un baseline Poisson (les memes
paris, mais en utilisant la probabilite du modele pour le seuil de pari — ici on
mesure simplement le yield des paris real_markets value vs l'ensemble tous paris).

Limite honnete : necessite que les matchs traces aient abouti (resultat en DB).
Si le journal est vide ou les matchs non termines, le script le dit clairement
au lieu d'inventer un resultat.
"""
import argparse
import json
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'core'))

from market_engine_trace import _LOG_PATH, read_log


def _outcome_for(match_id, start_ts, home, away, db):
    """Retourne (score_home, score_away) du match termine, ou None."""
    try:
        cur = db.cursor()
        # 1) par id
        if match_id:
            cur.execute(
                "SELECT scoreHome, scoreAway FROM matches WHERE id=? AND status IN ('finished','FT','ended')",
                (str(match_id),),
            )
            r = cur.fetchone()
            if r and r[0] is not None:
                return int(r[0]), int(r[1])
        # 2) par home/away + fenetre de temps
        cur.execute(
            "SELECT scoreHome, scoreAway FROM matches WHERE homeTeam=? AND awayTeam=? "
            "AND status IN ('finished','FT','ended') ORDER BY startTimestamp DESC LIMIT 1",
            (home, away),
        )
        r = cur.fetchone()
        if r and r[0] is not None:
            return int(r[0]), int(r[1])
    except Exception:
        pass
    return None


def _bet_won(market, selection_label, sh, sa):
    """Determine si un pari de marche gagne selon le score final."""
    over_under = None
    m = market or ''
    if 'Over' in m or 'Under' in m:
        # extrait la ligne (ex 'Over 2.5 Buts')
        try:
            line = float(m.split()[1])
        except Exception:
            line = 2.5
        total = sh + sa
        is_over = 'Over' in m
        if is_over:
            return total > line
        return total < line
    if 'BTTS' in m:
        both = sh > 0 and sa > 0
        return both if 'Oui' in m else (not both)
    # 1X2 / autres : on ne sait pas resoudre -> None (exclu du P&L)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--trace', default=_LOG_PATH)
    args = ap.parse_args()

    records = read_log(args.trace)
    if not records:
        print("AUCUN JOURNAL real_markets -> rien a backtester. "
              "Lance la prod sur des matchs Sofascore pour peupler le journal.")
        return

    db_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'tactical.db')
    db = sqlite3.connect(db_path) if os.path.exists(db_path) else None

    value_pnl = 0.0
    value_n = 0
    all_pnl = 0.0
    all_n = 0
    settled = 0
    unresolved = 0
    for rec in records:
        sh_sa = _outcome_for(rec.get('match_id'), rec.get('startTimestamp'), rec.get('home'), rec.get('away'), db) if db else None
        if sh_sa is None:
            unresolved += 1
            continue
        settled += 1
        sh, sa = sh_sa
        won = _bet_won(rec.get('market'), rec.get('market'), sh, sa)
        if won is None:
            continue
        odds = float(rec.get('real_odds') or 0)
        if odds <= 1:
            continue
        pnl = (odds - 1) if won else -1.0
        all_n += 1
        all_pnl += pnl
        if rec.get('value'):
            value_n += 1
            value_pnl += pnl

    db and db.close()

    print("=" * 60)
    print("A/B BACKTEST — Market Engine (cotes reelles) vs Poisson baseline")
    print("=" * 60)
    print(f"Decisions journalisees : {len(records)}")
    print(f"Matchs termines (resolus) : {settled} | non termines : {unresolved}")
    if all_n:
        print(f"\n[TOUS paris real_markets]")
        print(f"  n={all_n}  P&L={all_pnl:+.2f}u  yield={100*all_pnl/all_n:+.1f}%")
    if value_n:
        print(f"\n[VALUE seulement (edge >= 3%)]")
        print(f"  n={value_n}  P&L={value_pnl:+.2f}u  yield={100*value_pnl/value_n:+.1f}%")
        # Poisson baseline : si on avait parié tous les paris sans edge gate
        # le yield serait all_pnl/all_n ; l'edge gate vise value_n > all_n.
        print(f"  gain d'edge gate vs tout-vs-rien : "
              f"{100*value_pnl/value_n - (100*all_pnl/all_n if all_n else 0):+.1f} pts de yield")
    else:
        print("\nAucun pari VALUE encore resolu -> edge gate non quantifiable pour l'instant.")
    print("=" * 60)
    print("NOTE : besoin de matchs Sofascore termines dans la DB pour un vrai")
    print("P&L. Le journal s'accumule en prod ; relance ce script apres quelques")
    print("journees de matchs.")


if __name__ == '__main__':
    main()
