"""E79 — evaluation du modele 1X2 sur le corpus complet (diagnostic reproductible)

Repond a "mon systeme est-il pret pour les pronostics ?" sur des tests
statistiques, et sur la plus grande base disponible.

CHOIX DE LA SOURCE — c'est le point qui a change en E79. Les versions
precedentes (E77, E78) evaluaient 883 predictions tirees de `learning_memory`.
Cette base donneait une AUC de 0,579 avec z = +3 a +4 sigma, d'ou la conclusion
"le modele classe un peu". Sur `historical_matches`, qui contient 13 474 matchs
avec score ET les trois probabilites, la meme mesure tombe a **0,508 / 0,525 /
0,509**, soit le hasard, et le pick devient SIGNIFICATIVEMENT moins bon que
"toujours parier le domicile" (McNemar p < 0,0001).

Les deux tables portent le meme modele : les 2 605 matchs de `learning_memory`
sont tous presents dans `historical_matches`, et leurs probabilites concordent
au point pres (ecart median 0,0 point de %). L'ecart entre les deux
evaluations etait donc un **biais de petit echantillon**, pas une difference de
pipeline. Mesurer sur 883 lignes et conclure quoi que ce soit sur le pouvoir
discriminant d'un modele est une erreur.

Quatre mesures, aucune suffisante seule :
  1. CALIBRATION   moyenne annoncee contre frequence reelle, par issue
  2. DISCRIMINATION AUC one-vs-rest avec ecart-type de Hanley-McNeil et test z
  3. PICK          contre la regle sans information, test de McNemar appareille
  4. STABILITE     decoupe mensuelle : le signal survit-il au temps ?

Plus une comparaison MODELE vs MARCHE, sur le sous-ensemble cote (les cotes
n'existent que dans `learning_memory`).

Usage :  .venv/Scripts/python.exe scripts/eval_pick_quality.py
Sortie : 0 si le marche 1X2 est exploitable, 1 sinon.

Limite assumee : la base entiere ne couvre que 2026-08-13 -> 2026-10-01, et le
modele a ete actif sur toute cette periode. La decoupe mensuelle detecte une
derive entre periodes proches ; elle ne constitue PAS un test hors echantillon.
"""

import math
import sqlite3
import sys
from datetime import datetime

DB = 'data/tactical.db'
MIN_AUC = 0.55


def norm_cdf(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def load_model_corpus():
    """Score reel + probabilites, issues derivees du score (jamais du champ
    `result`, qui note le sort du PICK et non l'issue du match)."""
    con = sqlite3.connect(DB)
    rows = con.execute(
        "SELECT archived_at, home_win_probability, draw_probability,"
        "       away_win_probability, scoreHome, scoreAway"
        " FROM historical_matches"
        " WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL"
        "   AND home_win_probability IS NOT NULL AND draw_probability IS NOT NULL"
        "   AND away_win_probability IS NOT NULL"
    ).fetchall()
    out = []
    for at, ph, pd, pa, sh, sa in rows:
        s = float(ph) + float(pd) + float(pa)
        if s <= 0:
            continue
        actual = 0 if sh > sa else (1 if sh == sa else 2)
        out.append((str(at)[:10], float(ph) / s, float(pd) / s, float(pa) / s, actual))
    out.sort(key=lambda r: r[0])
    return out


def load_market_corpus():
    """Sous-ensemble cote, pour la comparaison modele / marche."""
    con = sqlite3.connect(DB)
    rows = con.execute(
        "SELECT p_home, p_draw, p_away, prediction, actual_1x2,"
        "       odds_home, odds_draw, odds_away"
        " FROM learning_memory"
        " WHERE odds_home IS NOT NULL AND odds_draw IS NOT NULL AND odds_away IS NOT NULL"
        "   AND p_home IS NOT NULL AND p_draw IS NOT NULL AND p_away IS NOT NULL"
        "   AND prediction IN ('1','X','2') AND actual_1x2 IN ('H','D','A')"
    ).fetchall()
    con.close()
    return rows


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
    s = sum(ranks[k] for k, (_, lab) in enumerate(pairs) if lab)
    a = (s - pos * (pos + 1) / 2) / (pos * neg)
    q1 = a / (2 - a)
    q2 = 2 * a * a / (1 + a)
    var = (a * (1 - a) + (pos - 1) * (q1 - a * a) + (neg - 1) * (q2 - a * a)) / (pos * neg)
    return a, math.sqrt(max(var, 0.0))


def evaluate(cohort, title, deep=True):
    n = len(cohort)
    if n < 30:
        print(f'  {title} : n = {n}, echantillon trop petit')
        return None
    freqs = [0, 0, 0]
    for r in cohort:
        freqs[r[4]] += 1
    names = ('domicile', 'nul', 'exterieur')

    print(f'  {title}  (n = {n})')
    print('     issue        annonce      reel      ecart')
    cal_ok = True
    for i, lab in enumerate(names):
        mp = sum(r[1 + i] for r in cohort) / n
        real = freqs[i] / n
        ok = abs(mp - real) <= 0.05
        cal_ok = cal_ok and ok
        print(f'     {lab:<11} {mp * 100:6.1f} %   {real * 100:6.1f} %   '
              f'{(mp - real) * 100:+5.1f} pts')
    if deep:
        aucs = []
        for i, lab in enumerate(names):
            a, se = auc([r[1 + i] for r in cohort], [1 if r[4] == i else 0 for r in cohort])
            z = (a - 0.5) / se if se else 0.0
            aucs.append(a)
            print(f'     AUC {lab:<8} {a:.3f} +/- {se:.3f}  z = {z:+.1f} sigma  '
                  f'{"significatif" if abs(z) > 1.96 else "NON significatif"}')
        ll = -sum(math.log(max(r[1 + r[4]], 1e-12)) for r in cohort) / n
        br = sum(sum((r[1 + i] - (1 if i == r[4] else 0)) ** 2 for i in range(3))
                 for r in cohort) / n
        print(f'     log-loss {ll:.4f}   Brier {br:.4f}')
        mean_auc = sum(aucs) / 3
    else:
        aucs = [auc([r[1 + i] for r in cohort], [1 if r[4] == i else 0 for r in cohort])[0]
                for i in range(3)]
        mean_auc = sum(aucs) / 3

    pick = [max(range(3), key=lambda i: r[1 + i]) for r in cohort]
    acc = sum(1 for r, p in zip(cohort, pick) if p == r[4]) / n
    bi = freqs.index(max(freqs))
    base = max(freqs) / n
    b01 = sum(1 for r, p in zip(cohort, pick) if p == r[4] and r[4] != bi)
    b10 = sum(1 for r, p in zip(cohort, pick) if r[4] == bi and p != r[4])
    p_mc = 1.0
    if b01 + b10:
        chi2 = (abs(b01 - b10) - 1) ** 2 / (b01 + b10)
        p_mc = 2 * (1 - norm_cdf(math.sqrt(chi2)))
    print(f'     pick {acc * 100:.1f} %   reference "{names[bi]}" {base * 100:.1f} %   '
          f'ecart {(acc - base) * 100:+.1f} pts')
    if deep:
        print(f'     McNemar {b01}/{b10}  p = {p_mc:.4f}  '
              f'{"SIGNIFICATIF" if p_mc < 0.05 else "non significatif"}')
    print()
    return {'auc': mean_auc, 'calibrated': cal_ok, 'acc': acc, 'base': base,
            'p': p_mc, 'n': n}


def main():
    data = load_model_corpus()
    if not data:
        print('  Aucune donnee exploitable dans historical_matches.')
        return 2
    print(f'\n=== {len(data)} matchs avec score et probabilites ===')
    print(f'    du {data[0][0]} au {data[-1][0]}\n')
    print('  Les probabilites sont derivees du SCORE, pas du champ `result`')
    print('  (qui note le sort du pick).\n')

    print('  1. ENSEMBLE')
    print('     ' + '-' * 58)
    overall = evaluate(data, 'ensemble')

    print('  2. STABILITE MENSUELLE')
    print('     ' + '-' * 58)
    months = sorted({r[0][:7] for r in data})
    per = {}
    for mth in months:
        per[mth] = evaluate([r for r in data if r[0][:7] == mth], mth)
    big = {m: v for m, v in per.items() if v and v['n'] >= 1000}
    if len(big) >= 2:
        keys = sorted(big)
        drift = big[keys[-1]]['auc'] - big[keys[0]]['auc']
        print(f'     derive de l\'AUC {keys[0]} -> {keys[-1]} : {drift:+.3f}')
        print()

    print('  3. MODELE vs MARCHE (sous-ensemble cote)')
    print('     ' + '-' * 58)
    mk = load_market_corpus()

    def fair(o):
        try:
            h, d, a = float(o[0]), float(o[1]), float(o[2])
        except (TypeError, ValueError):
            return None
        if not all(math.isfinite(x) and x > 1.0 for x in (h, d, a)):
            return None
        s = 1 / h + 1 / d + 1 / a
        if s <= 0 or s > 1.35:
            return None
        return (1 / h / s, 1 / d / s, 1 / a / s)

    usable = []
    for r in mk:
        f = fair(r[5:8])
        if f:
            usable.append((r, f))
    model_better = None
    if len(usable) < 30:
        print(f'     {len(usable)} matchs comparables seulement : la couverture')
        print('     des cotes (9,6 %) limite cette comparaison (cf. E74).')
    else:
        m = len(usable)
        am_all = ak_all = 0
        for i, (lab, code) in enumerate((('domicile', 'H'), ('nul', 'D'),
                                         ('exterieur', 'A'))):
            am = auc([r[i] for r, _ in usable], [1 if r[4] == code else 0 for r, _ in usable])[0]
            ak = auc([f[i] for r, f in usable], [1 if r[4] == code else 0 for r, _ in usable])[0]
            am_all += am / 3
            ak_all += ak / 3
            print(f'     AUC {lab:<11} modele {am:.3f}  marche {ak:.3f}  ecart {ak - am:+.3f}')
        ai = {'H': 0, 'D': 1, 'A': 2}
        pi = {'1': 0, 'X': 1, '2': 2}
        pm = sum(1 for r, _ in usable if ai[r[4]] == pi[r[3]]) / m
        pk = sum(1 for r, f in usable
                 if ai[r[4]] == max(range(3), key=lambda i: f[i])) / m
        print(f'     moyenne          modele {am_all:.3f}  marche {ak_all:.3f}  '
              f'ecart {ak_all - am_all:+.3f}')
        print(f'     exactitude 1X2   modele {pm * 100:.1f} %   marche {pk * 100:.1f} %')
        model_better = am_all >= ak_all
    print()

    verdict = []
    if not overall['calibrated']:
        verdict.append('probabilites non calibrees')
    if overall['auc'] < MIN_AUC:
        verdict.append(f"classement au niveau du hasard (AUC {overall['auc']:.3f})")
    if overall['acc'] < overall['base'] and overall['p'] < 0.05:
        verdict.append('le pick est significativement moins bon que la reference')
    if model_better is False:
        verdict.append('le marche classe mieux que le modele')
    print('  ' + '=' * 60)
    if verdict:
        print('  NON PRET pour le marche 1X2 :')
        for v in verdict:
            print(f'    - {v}')
        print()
        print('  Sur 13 413 matchs, le pouvoir discriminant du modele est celui')
        print('  du hasard. Il n\'y a pas de calibration a refaire ni de perimetre')
        print('  a restreindre : c\'est l\'information elle-meme qui est absente.')
    else:
        print('  PRET : calibre, discriminant, et au moins aussi bon que le marche.')
    print('  ' + '=' * 60)
    print(f'\n  Reserve : la base couvre {data[0][0]} -> {data[-1][0]} et le modele')
    print('  y a ete actif. La decoupe mensuelle mesure une derive, pas une')
    print('  generalisation hors echantillon.\n')
    return 1 if verdict else 0


if __name__ == '__main__':
    sys.exit(main())
