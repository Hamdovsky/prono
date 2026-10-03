"""E80 — le registre prediction_history confirme-t-il E79 sur un jeu distinct ?

`prediction_history` est le registre par issue : 3 lignes par match (Home /
Draw / Away), chacune avec la probabilite du modele et le resultat de CETTE
issue (won/lost). 16 379 matchs, 14 171 entierement regles, probabilites
sommant a 1,000 +/- 0,001.

C'est un jeu independant de `historical_matches` : meme modele, autre table,
autre pipeline d'ecriture. Si les deux donnent le meme verdict, le constat
d'E79 n'est pas un artefact d'un script.

Recalcule les memes quatre mesures que scripts/eval_pick_quality.py :
calibration, AUC +/- sigma, log-loss / Brier, pick contre la reference avec
McNemar, plus la decoupe mensuelle.

Usage : .venv/Scripts/python.exe scripts/eval_prediction_history.py
"""
import math
import sqlite3
import sys
from datetime import datetime, timezone

DB = 'data/tactical.db'
TYPES = ('Home', 'Draw', 'Away')


def norm_cdf(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def load():
    con = sqlite3.connect(DB)
    rows = con.execute(
        "SELECT match_id, prediction_type, probability, result, timestamp"
        " FROM prediction_history WHERE result IS NOT NULL"
        " AND probability IS NOT NULL"
    ).fetchall()
    con.close()
    by_match = {}
    for mid, ptype, p, res, ts in rows:
        by_match.setdefault(mid, {})[ptype] = (float(p), res, ts)
    out = []
    for mid, d in by_match.items():
        if any(t not in d for t in TYPES):
            continue
        ph, rh, ts = d['Home']
        pd, rd, _ = d['Draw']
        pa, ra, _ = d['Away']
        wins = [t for t in TYPES if d[t][1] == 'won']
        if len(wins) != 1:
            continue
        s = ph + pd + pa
        if s <= 0:
            continue
        i = TYPES.index(wins[0])
        ms = ts / 1000.0 if ts and ts > 1e11 else float(ts or 0)
        day = (datetime.fromtimestamp(ms, tz=timezone.utc).strftime('%Y-%m-%d')
               if ms else '?')
        out.append((day, ph / s, pd / s, pa / s, i))
    out.sort(key=lambda r: r[0])
    return out


def auc(scores, labels):
    pairs = sorted(zip(scores, labels))
    ranks = [0.0] * len(pairs)
    i = 0
    while i < len(pairs):
        j = i
        while j + 1 < len(pairs) and pairs[j + 1][0] == pairs[i][0]:
            j += 1
        r = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[k] = r
        i = j + 1
    pos = sum(labels)
    neg = len(labels) - pos
    if pos == 0 or neg == 0:
        return float('nan'), float('nan')
    a = (sum(ranks[k] for k, (_, lab) in enumerate(pairs) if lab)
         - pos * (pos + 1) / 2) / (pos * neg)
    q1 = a / (2 - a)
    q2 = 2 * a * a / (1 + a)
    var = (a * (1 - a) + (pos - 1) * (q1 - a * a)
           + (neg - 1) * (q2 - a * a)) / (pos * neg)
    return a, math.sqrt(max(var, 0.0))


def evaluate(cohort, title):
    n = len(cohort)
    if n < 30:
        print(f'  {title} : n = {n}, trop petit\n')
        return None
    freqs = [0, 0, 0]
    for r in cohort:
        freqs[r[4]] += 1
    names = ('domicile', 'nul', 'exterieur')
    print(f'  {title}  (n = {n})')
    print('     issue        annonce      reel      ecart')
    for i, lab in enumerate(names):
        mp = sum(r[1 + i] for r in cohort) / n
        real = freqs[i] / n
        print(f'     {lab:<11} {mp * 100:6.1f} %   {real * 100:6.1f} %   '
              f'{(mp - real) * 100:+5.1f} pts')
    aucs = []
    for i, lab in enumerate(names):
        a, se = auc([r[1 + i] for r in cohort],
                    [1 if r[4] == i else 0 for r in cohort])
        z = (a - 0.5) / se if se else 0.0
        aucs.append(a)
        print(f'     AUC {lab:<8} {a:.3f} +/- {se:.3f}  z = {z:+.1f} sigma  '
              f'{"significatif" if abs(z) > 1.96 else "NON significatif"}')
    ll = -sum(math.log(max(r[1 + r[4]], 1e-12)) for r in cohort) / n
    br = sum(sum((r[1 + i] - (1 if i == r[4] else 0)) ** 2 for i in range(3))
             for r in cohort) / n
    print(f'     log-loss {ll:.4f}   Brier {br:.4f}')
    pick = [max(range(3), key=lambda i: r[1 + i]) for r in cohort]
    acc = sum(1 for r, p in zip(cohort, pick) if p == r[4]) / n
    bi = freqs.index(max(freqs))
    base = max(freqs) / n
    b01 = sum(1 for r, p in zip(cohort, pick) if p == r[4] and r[4] != bi)
    b10 = sum(1 for r, p in zip(cohort, pick) if r[4] == bi and p != r[4])
    p_mc = 1.0
    if b01 + b10:
        p_mc = 2 * (1 - norm_cdf(math.sqrt((abs(b01 - b10) - 1) ** 2
                                           / (b01 + b10))))
    print(f'     pick {acc * 100:.1f} %   reference "{names[bi]}" '
          f'{base * 100:.1f} %   ecart {(acc - base) * 100:+.1f} pts')
    print(f'     McNemar {b01}/{b10}  p = {p_mc:.4f}  '
          f'{"SIGNIFICATIF" if p_mc < 0.05 else "non significatif"}\n')
    return {'auc': sum(aucs) / 3, 'acc': acc, 'base': base, 'p': p_mc, 'n': n}


def main():
    data = load()
    if not data:
        print('  Aucune donnee exploitable dans prediction_history.')
        return 2
    print(f'\n=== prediction_history : {len(data)} matchs complets ===')
    print(f'    du {data[0][0]} au {data[-1][0]}\n')
    print('  Ce tableau est independant de historical_matches : meme modele,')
    print('  autre pipeline d\'ecriture. Sert de contre-verification.\n')

    print('  ENSEMBLE')
    print('  ' + '-' * 58)
    o = evaluate(data, 'ensemble')

    months = sorted({r[0][:7] for r in data})
    per = {m: evaluate([r for r in data if r[0][:7] == m], m) for m in months}
    big = sorted(m for m, v in per.items() if v and v['n'] >= 1000)
    if len(big) >= 2:
        print(f'  derive de l\'AUC {big[0]} -> {big[-1]} : '
              f'{per[big[-1]]["auc"] - per[big[0]]["auc"]:+.3f}\n')

    print('  ' + '=' * 60)
    if o['auc'] < 0.55:
        print('  AUC 1X2 sous 0,55 : meme constat qu\'E79, sur un second')
        print('  jeu de donnees. Le modele ne classe pas.')
    if o['acc'] < o['base'] and o['p'] < 0.05:
        print('  Pick inferieur a la reference, significativement.')
    print('  ' + '=' * 60)
    print('\n  Reserve : 2026-08 -> 2026-10 seulement, modele actif partout.\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
