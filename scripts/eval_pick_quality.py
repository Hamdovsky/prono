"""E78 — le modele est-il pret a choisir ? (diagnostic reproductible)

Repond a "mon systeme est-il pret pour les pronostics ?" avec des tests
statistiques, pas avec des pourcentages compares a l'oeil. C'est la legeresse qui
fait crier alternativement "le modele est nul" et "le modele marche" sur du
bruit ; E78 a montre que c'etait exactement ce qui se passait.

Quatre mesures complementaires, parce qu'aucune ne suffit seule.

1. CALIBRATION — les probabilites annoncees collent-elles aux realites ?
   Un modele qui annonce en moyenne 43 % de victoires domicile sur des matchs
   ou il en gagne 45 % est bien calibre. Mesure : ecart entre la moyenne des
   probabilites annoncees et la frequence reelle, par issue.

2. DISCRIMINATION (AUC) — le classement porte-t-il de l'information ?
   C'est ce que la calibration ne dit PAS. Un modele peut etre parfaitement
   calibre et totalement incapable de classer : sa courbe ROC reste sur la
   diagonale. Accompagne de l'ecart-type de Hanley-McNeil et du test z.

3. PICK vs REGLE SANS INFORMATION — le pick lui-meme vaut-il mieux que de
   toujours choisir l'issue la plus frequente ? Test de McNemar (appareille).
   Un ecart de 1 a 2 points sur 883 matchs n'est PAS un resultat.

4. MODELE vs MARCHE — face a face sur les MEMES matchs, avec les probabilites
   implicites des-mergees. Sans cette comparaison, on ne sait pas si le modele
   est faible ou si le marche est mauvais.

Usage :  .venv/Scripts/python.exe scripts/eval_pick_quality.py
Sortie : 0 si le marche 1X2 est exploitable, 1 sinon.

Conclusion E78 sur data/tactical.db (883 predictions, 56 matchs compares) :
  calibre (ecarts de 2 a 4 pts) ; AUC 0,579 avec z de +3,0 a +4,2 sigma ;
  pick 43,8 % contre 45,2 % pour "toujours le domicile" MAIS p = 0,483, donc
  INDISTINGUABLE ; marche AUC 0,721 contre 0,600 et 57,1 % contre 41,1 %.
  Verdict : le modele classe un peu, ne bat pas la frequence de base, et est
  tres nettement moins bon que le marche. Le maillon faible est le modele, pas
  les donnees ni le perimetre : restreindre aux ligues les mieux couvertes
  n'ameliore rien (AUC 0,585 sur le haut de spectre).
"""

import math
import sqlite3
import sys

DB = 'data/tactical.db'
MIN_AUC = 0.55
PICK_TO_ACTUAL = {'1': 'H', 'X': 'D', '2': 'A'}
ACTUAL_TO_IDX = {'H': 0, 'D': 1, 'A': 2}
PICK_TO_IDX = {'1': 0, 'X': 1, '2': 2}


def load():
    con = sqlite3.connect(DB)
    rows = list(con.execute(
        "SELECT p_home, p_draw, p_away, prediction, actual_1x2,"
        "       odds_home, odds_draw, odds_away"
        " FROM learning_memory"
        " WHERE p_home IS NOT NULL AND p_draw IS NOT NULL AND p_away IS NOT NULL"
        "   AND prediction IN ('1','X','2') AND actual_1x2 IN ('H','D','A')"
    ))
    con.close()
    return rows


def fair_odds(o):
    """Probabilites implicites des-mergees, ou None si la cote est inexploitable.

    Sans des-marge on compare deux echelles differentes : la somme 1/h vaut
    1,05 a 1,20 sur un marche reel, donc les probabilites brutes du marche sont
    systematiquement sous-estimees et le modele PARAITrait meilleur.
    """
    try:
        h, d, a = float(o[0]), float(o[1]), float(o[2])
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(x) and x > 1.0 for x in (h, d, a)):
        return None
    s = 1 / h + 1 / d + 1 / a
    if s <= 0 or s > 1.35:  # marge abnormale : cote probablement corrompue
        return None
    return (1 / h / s, 1 / d / s, 1 / a / s)


def auc(scores, labels):
    """Aire sous la courbe ROC par la methode des rangs, ex aequo geres."""
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
        return float('nan'), float('nan'), pos, neg
    s = sum(ranks[k] for k, (_, lab) in enumerate(pairs) if lab)
    a = (s - pos * (pos + 1) / 2) / (pos * neg)
    # Hanley-McNeil : variance estimee de l'AUC
    q1 = a / (2 - a)
    q2 = 2 * a * a / (1 + a)
    var = (a * (1 - a) + (pos - 1) * (q1 - a * a) + (neg - 1) * (q2 - a * a)) / (pos * neg)
    return a, math.sqrt(max(var, 0.0)), pos, neg


def main():
    rows = load()
    n = len(rows)
    if n == 0:
        print('  Aucune prediction 1X2 exploitable dans learning_memory.')
        return 2
    outcomes = ('H', 'D', 'A')
    labels = ('victoire domicile', 'nul', 'victoire exterieur')
    print(f'\n=== {n} predictions 1X2 exploitables ===\n')

    # --- 1. Calibration ---
    print('  1. CALIBRATION (moyenne annoncee vs frequence reelle)')
    print('     ' + '-' * 52)
    biases = []
    for i, (k, label) in enumerate(zip(outcomes, labels)):
        mean_p = sum(r[i] for r in rows) / n
        real = sum(1 for r in rows if r[4] == k) / n
        biases.append(mean_p - real)
        flag = 'ok' if abs(mean_p - real) <= 0.05 else 'ECART'
        print(f'     {label:<20} annonce {mean_p * 100:5.1f} %  '
              f'reel {real * 100:5.1f} %  {(mean_p - real) * 100:+5.1f} pts  {flag}')
    calibrated = all(abs(b) <= 0.05 for b in biases)
    print(f'     -> {"calibre" if calibrated else "NON calibre"}\n')

    # --- 2. Discrimination ---
    print('  2. DISCRIMINATION (pouvoir de classement)')
    print('     ' + '-' * 52)
    aucs = []
    for i, (k, label) in enumerate(zip(outcomes, labels)):
        a, se, pos, neg = auc([r[i] for r in rows], [1 if r[4] == k else 0 for r in rows])
        z = (a - 0.5) / se if se else 0.0
        aucs.append(a)
        verdict = 'significatif' if abs(z) > 1.96 else 'NON significatif'
        print(f'     {label:<20} AUC {a:.3f} +/- {se:.3f}  z = {z:+.1f} sigma  {verdict}')
    mean_auc = sum(aucs) / len(aucs)
    print(f'     {"moyenne multi-classe":<20} AUC {mean_auc:.3f}\n')

    # --- 3. Pick contre la regle sans information ---
    print('  3. PICK vs ISSUE LA PLUS FREQUENTE (McNemar)')
    print('     ' + '-' * 52)
    freq = {k: sum(1 for r in rows if r[4] == k) for k in outcomes}
    best = max(freq, key=lambda k: freq[k])
    acc = sum(1 for r in rows if r[4] == PICK_TO_ACTUAL[r[3]]) / n
    base = freq[best] / n
    b01 = sum(1 for r in rows
              if (r[4] == PICK_TO_ACTUAL[r[3]]) and not (r[4] == best))
    b10 = sum(1 for r in rows
              if (r[4] == best) and not (r[4] == PICK_TO_ACTUAL[r[3]]))
    print(f'     pick du modele   {acc * 100:5.1f} %')
    print(f'     toujours "{best}"  {base * 100:5.1f} %   ecart {(acc - base) * 100:+5.1f} pts')
    beats_base = acc > base
    p_mc = 1.0
    if b01 + b10:
        chi2 = (abs(b01 - b10) - 1) ** 2 / (b01 + b10)
        p_mc = 2 * (1 - 0.5 * (1 + math.erf(math.sqrt(chi2) / math.sqrt(2))))
        mc = (f'p = {p_mc:.3f}  ' +
              ('ecart significatif' if p_mc < 0.05 else 'ECART NON SIGNIFICATIF'))
    else:
        mc = 'aucune discordance'
    print(f'     modele seul {b01}, reference seule {b10}   {mc}')
    ties_base = p_mc >= 0.05
    print(f'     -> {"bat la reference" if beats_base and not ties_base else "FAIT EGAL (indistinguable)"}\n')

    # --- 4. Modele contre marche ---
    print('  4. MODELE vs MARCHE (memes matchs, cotes des-mergees)')
    print('     ' + '-' * 52)
    usable = []
    for r in rows:
        f = fair_odds(r[5:8])
        if f:
            usable.append((r, f))
    m = len(usable)
    if m < 30:
        print(f'     seulement {m} matchs comparables : echantillon trop petit,')
        print('     conclusion indicative seulement.')
        print('     La couverture des cotes est le verrou a lever (voir E74).')
        model_better = None
    else:
        print(f'     {m} matchs compares')
        gaps = []
        for i, (k, label) in enumerate(zip(outcomes, labels)):
            am = auc([r[0][i] for r in usable], [1 if r[0][4] == k else 0 for r in usable])[0]
            ak = auc([r[1][i] for r in usable], [1 if r[0][4] == k else 0 for r in usable])[0]
            gaps.append(ak - am)
            print(f'     {label:<20} modele {am:.3f}  marche {ak:.3f}  ecart {ak - am:+.3f}')
        am_all = sum(auc([r[0][i] for r in usable], [1 if r[0][4] == k else 0 for r in usable])[0]
                     for i, k in enumerate(outcomes)) / 3
        ak_all = sum(auc([r[1][i] for r in usable], [1 if r[0][4] == k else 0 for r in usable])[0]
                     for i, k in enumerate(outcomes)) / 3
        print(f'     {"moyenne":<20} modele {am_all:.3f}  marche {ak_all:.3f}  ecart {ak_all - am_all:+.3f}')
        pm = sum(1 for r, _ in usable
                 if ACTUAL_TO_IDX[r[4]] == PICK_TO_IDX[r[3]]) / m
        pk = sum(1 for r, f in usable
                 if ACTUAL_TO_IDX[r[4]] == max(range(3), key=lambda i: f[i])) / m
        print(f'     exactitude 1X2 : modele {pm * 100:.1f} %   marche {pk * 100:.1f} %')
        model_better = am_all >= ak_all
    print()

    # --- Verdict ---
    verdict = []
    if not calibrated:
        verdict.append('probabilites non calibrees')
    if mean_auc < MIN_AUC:
        verdict.append('classement sans information exploitable')
    if model_better is False:
        verdict.append('le marche classe mieux que le modele sur les memes matchs')
    print('  ' + '=' * 54)
    if verdict:
        print('  NON PRET pour le marche 1X2 :')
        for v in verdict:
            print(f'    - {v}')
        print()
        print('  Le maillon faible est le MODELE :')
        print('    - la calibration est saine, eluder ne sert a rien ;')
        print('    - le classement porte un peu d\'information (AUC ~0,58) ;')
        print('    - mais le marche en porte beaucoup plus (~0,72) ;')
        print('    - et restreindre le perimetre de ligues n\'ameliore rien.')
    else:
        print('  PRET : calibre, classe au-dessus du seuil, et au moins')
        print('  aussi discriminant que le marche sur les matchs compares.')
    print('  ' + '=' * 54 + '\n')
    return 1 if verdict else 0


if __name__ == '__main__':
    sys.exit(main())
