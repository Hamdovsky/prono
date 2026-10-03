"""Mesure honnete de la performance du modele (chantier 1 de l'etude E72).

Jusqu'ici, `learning_memory` ne conservait que le pick (`prediction`) et son sort
(`actual`). Impossible de calculer un Brier ou un log-loss : on ne connaissait ni
les probabilites annoncees, ni le resultat reel du match distingue du sort du pick.

Ce script lit les colonnes ajoutees en E73 (`p_home`/`p_draw`/`p_away` +
`actual_1x2`) et produit les metriques qui manquaient.

Deux garde-fous explicites, parce que ce sont les deux pieges deja rencontres :
  - renormalisation des probabilites avant tout calcul (stockage possible en %)
  - rejet des lignes sans verite terrain : `actual` note le PICK, pas le match
Usage : python scripts/measure_performance.py [--by-league]
"""

import argparse
import sqlite3
from collections import defaultdict
from math import isfinite, log

DB = 'data/tactical.db'
RANDOM_BRIER = 0.3333
RANDOM_LOGLOSS = 1.0986


def load(db_path):
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    try:
        cur.execute(
            'SELECT league, p_home, p_draw, p_away, actual_1x2, odds_home, '
            'odds_draw, odds_away, score, prediction, confidence '
            'FROM learning_memory')
        cols = [c[1] for c in cur.execute(
            'PRAGMA table_info("learning_memory")')]
    except sqlite3.OperationalError as e:
        con.close()
        raise SystemExit(f'TABLE ILLISIBLE: {e}\n'
                         'Les colonnes E73 sont absentes : le schema n\'a pas ete '
                         'migrationne sur cette base.')
    rows = cur.execute(
        'SELECT league, p_home, p_draw, p_away, actual_1x2, odds_home, '
        'odds_draw, odds_away, score, prediction, confidence '
        'FROM learning_memory').fetchall()
    con.close()
    return cols, rows


def normalise(ph, pd_, pa):
    """Ramene a [0,1] quel que soit l'echelle stockee (0-1 ou 0-100)."""
    vals = []
    for v in (ph, pd_, pa):
        if v is None:
            return None
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        if not isfinite(f):
            return None
        vals.append(f)
    if all(v is None for v in vals):
        return None
    tot = sum(vals)
    if tot <= 0:
        return None
    return [v / tot for v in vals]


def score_match(match_id, row, verbose=False):
    league, ph, pd_, pa, actual, oh, od, oa, score, pred, conf = row
    probs = normalise(ph, pd_, pa)
    if probs is None:
        return None
    if actual not in ('H', 'D', 'A'):
        return None
    y = {'H': 0, 'D': 1, 'A': 2}[actual]
    brier = sum((probs[i] - (1 if i == y else 0)) ** 2 for i in range(3)) / 3
    ll = -log(min(max(probs[y], 1e-12), 1 - 1e-12))
    pick = max(range(3), key=lambda i: probs[i])
    hit = 1 if pick == y else 0
    if verbose:
        print(f'  {match_id} score={score} pick={pred} conf={conf} '
              f'probs={["%.3f" % p for p in probs]} reel={actual}')
    return {
        'match_id': match_id, 'league': league, 'probs': probs,
        'y': y, 'brier': brier, 'logloss': ll, 'hit': hit,
        'pick_p': probs[pick], 'odds': (oh, od, oa), 'score': score,
    }


def report(obs, label=''):
    if not obs:
        print(f'\n{label}: AUCUN MATCH MESURABLE.')
        print('  Raison probable : les colonnes existent mais sont NULL.')
        print('  Elles se remplissent au prochain passage de '
              'runAdaptiveLearning() (cron 02:30),')
        print('  ou immediatement via : npm run learn:batch')
        return
    n = len(obs)
    brier = sum(o['brier'] for o in obs) / n
    ll = sum(o['logloss'] for o in obs) / n
    acc = 100 * sum(o['hit'] for o in obs) / n
    print(f'\n{label}')
    print(f'  matchs mesures      : {n}')
    print(f'  Brier moyen         : {brier:.4f}   (hasard = {RANDOM_BRIER:.4f})')
    print(f'  Log-loss moyen      : {ll:.4f}   (hasard = {RANDOM_LOGLOSS:.4f})')
    print(f'  Exactitude argmax   : {acc:.1f}%')
    if ll < RANDOM_LOGLOSS:
        print(f'  VERDICT             : bat le hasard (log-loss inferieure)')
    else:
        print(f'  VERDICT             : NE BAT PAS le hasard')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default=DB)
    ap.add_argument('--by-league', action='store_true')
    ap.add_argument('--calibration', action='store_true')
    ap.add_argument('--debug', action='store_true')
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    cur = con.cursor()
    cols = [c[1] for c in cur.execute('PRAGMA table_info("learning_memory")')]
    total = cur.execute('SELECT COUNT(*) FROM learning_memory').fetchone()[0]

    print('=' * 70)
    print('MESURE DE PERFORMANCE - E73')
    print('=' * 70)
    e73 = ['p_home', 'p_draw', 'p_away', 'actual_1x2']
    print(f'  entrees learning_memory : {total}')
    print(f'  colonnes E73 presentes  : '
          f'{sum(1 for c in e73 if c in cols)}/4')
    if not all(c in cols for c in e73):
        missing = [c for c in e73 if c not in cols]
        print(f'  MANQUANTES : {missing}')
        print('  -> lancer la migration du schema avant de mesurer.')
        con.close()
        return
    for c in e73:
        n = cur.execute(f'SELECT COUNT({c}) FROM learning_memory').fetchone()[0]
        print(f'    {c:12} renseigne : {n}/{total}')

    rows = cur.execute(
        'SELECT match_id, league, p_home, p_draw, p_away, actual_1x2, '
        'odds_home, odds_draw, odds_away, score, prediction, confidence '
        'FROM learning_memory').fetchall()
    con.close()

    obs = []
    for r in rows:
        s = score_match(r[0], r[1:], verbose=args.debug)
        if s:
            obs.append(s)

    report(obs, 'GLOBAL')

    # Pourquoi des lignes sont-elles ecartees ?
    no_prob = sum(1 for r in rows if normalise(r[2], r[3], r[4]) is None)
    no_truth = sum(1 for r in rows if r[5] not in ('H', 'D', 'A'))
    print(f'\n  lignes ecartees sans probas exploitables : {no_prob}')
    print(f'  lignes ecartees sans verite terrain      : {no_truth}')

    if args.calibration and obs:
        print('\n' + '=' * 70)
        print('CALIBRATION (confiance annoncee vs frequence reelle)')
        print('=' * 70)
        print('  confiance   n     reel    ecart')
        buckets = defaultdict(lambda: [0, 0])
        for o in obs:
            b = min(int(o['pick_p'] * 10), 9)
            buckets[b][0] += 1
            buckets[b][1] += o['hit']
        for b in sorted(buckets):
            n, c = buckets[b]
            if n < 10:
                continue
            conf, real = b / 10 + 0.05, c / n
            d = real - conf
            flag = ''
            if abs(d) > 0.07 and n >= 30:
                flag = '  <<< SURCONFiant' if d < 0 else '  <<< sous-confiant'
            print(f'   {conf:.2f}      {n:5}  {real:.3f}  {d:+.3f}{flag}')

    if args.by_league and obs:
        print('\n' + '=' * 70)
        print('PAR LIGUE')
        print('=' * 70)
        per = defaultdict(list)
        for o in obs:
            per[o['league']].append(o)
        print('  ligue                      n    brier  logloss  acc')
        for lg, items in sorted(per.items(), key=lambda x: -len(x[1]))[:20]:
            m = len(items)
            b = sum(i['brier'] for i in items) / m
            ll = sum(i['logloss'] for i in items) / m
            a = 100 * sum(i['hit'] for i in items) / m
            print(f'  {str(lg)[:26]:28}{m:4}  {b:.4f}  {ll:.4f}  {a:5.1f}%')

    if obs:
        print(f'\n  -> {len(obs)} matchs exploitables sur {total}. '
              f'La mesure est enfin possible.')


if __name__ == '__main__':
    main()