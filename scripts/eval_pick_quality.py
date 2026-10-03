"""E77 — le modele est-il pret a choisir ? (diagnostic reproductible)

Repond a "mon systeme est-il pret pour les pronostics ?" avec trois mesures
complementaires, parce qu'aucune ne suffit seule.

1. CALIBRATION — les probabilites annoncees collent-elles aux realites ?
   Un modele qui annonce en moyenne 43 % de victoires domicile sur des matchs
   ou il en gagne 45 % est bien calibre. Mesure : ecart entre la moyenne des
   probabilites annoncees et la frequence reelle, par issue.

2. DISCRIMINATION (AUC) — le classement porte-t-il de l'information ?
   C'est ce que la calibration ne dit PAS. Un modele peut etre parfaitement
   calibre et totalement incapable de classer : sa courbe ROC reste sur la
   diagonale. Mesure : AUC par issue (one-vs-rest) et moyenne multi-classe.
   0,5 = aucune information ; 0,579 = information reelle mais faible.

3. ARGMAX vs BASE RATE — le pick lui-meme bat-il la regle sans information ?
   C'est ce qui compte pour un parieur, et c'est distinct de l'AUC : un modele
   peut bien classer et mal identifier le premier. Reference : toujours choisir
   l'issue la plus frequente.

Usage :  .venv/Scripts/python.exe scripts/eval_pick_quality.py

Lecture : un systeme pret exige (1) calibration correcte, (2) AUC nettement
superieure a 0,5, (3) un argmax qui bat la frequence de base. Les trois sont
necessaires ; (3) seul suffit a disqualifier le marche pour du parieur.
"""

import sqlite3
import sys

DB = 'data/tactical.db'
MIN_AUC = 0.55


def load():
    con = sqlite3.connect(DB)
    rows = list(con.execute(
        "SELECT p_home, p_draw, p_away, prediction, actual_1x2 FROM learning_memory"
        " WHERE p_home IS NOT NULL AND p_draw IS NOT NULL AND p_away IS NOT NULL"
        "   AND prediction IN ('1','X','2')"
        "   AND actual_1x2 IN ('H','D','A')"
    ))
    con.close()
    return rows


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
        return float('nan')
    s = sum(ranks[k] for k, (_, lab) in enumerate(pairs) if lab)
    return (s - pos * (pos + 1) / 2) / (pos * neg)


def main():
    rows = load()
    n = len(rows)
    if n == 0:
        print('  Aucune prediction 1X2 exploitable dans learning_memory.')
        return 2
    outcomes = ('H', 'D', 'A')
    labels = ('victoire domicile', 'nul', 'victoire exterieur')
    pick_to_actual = {'1': 'H', 'X': 'D', '2': 'A'}

    print(f'\n=== {n} predictions 1X2 exploitables ===\n')

    # 1. Calibration
    print('  1. CALIBRATION (moyenne annoncee vs frequence reelle)')
    print('     ' + '-' * 50)
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

    # 2. Discrimination
    print('  2. DISCRIMINATION (pouvoir de classement)')
    print('     ' + '-' * 50)
    aucs = []
    for i, (k, label) in enumerate(zip(outcomes, labels)):
        a = auc([r[i] for r in rows], [1 if r[4] == k else 0 for r in rows])
        aucs.append(a)
        flag = 'informatif' if a >= MIN_AUC else 'NUL'
        print(f'     {label:<20} AUC {a:.3f}  {flag}')
    mean_auc = sum(aucs) / len(aucs)
    print(f'     {"moyenne multi-classe":<20} AUC {mean_auc:.3f}')
    print(f'     -> {"classe correctement" if mean_auc >= MIN_AUC else "NE CLASSE PAS"}\n')

    # 3. Argmax contre la regle sans information
    print('  3. PICK (argmax) vs ISSUE LA PLUS FREQUENTE')
    print('     ' + '-' * 50)
    acc = sum(1 for r in rows if r[4] == pick_to_actual[r[3]]) / n
    freq = {k: sum(1 for r in rows if r[4] == k) for k in outcomes}
    best = max(freq, key=lambda k: freq[k])
    base = freq[best] / n
    print(f'     pick du modele        {acc * 100:5.1f} %')
    print(f'     toujours "{best}"       {base * 100:5.1f} %')
    print(f'     ecart                 {(acc - base) * 100:+5.1f} pts')
    beats_base = acc > base
    print(f'     -> {"bat la reference" if beats_base else "PERD face a la reference"}\n')

    verdict = []
    if not calibrated:
        verdict.append('probabilites non calibrees')
    if mean_auc < MIN_AUC:
        verdict.append('classement sans information')
    if not beats_base:
        verdict.append('le pick ne bat pas la frequence de base')
    print('  ' + '=' * 50)
    if verdict:
        print('  NON PRET pour le marche 1X2 :')
        for v in verdict:
            print(f'    - {v}')
        print('  Calibrer ne suffira pas si le classement est en cause.')
    else:
        print('  PRET : calibre, classe, et le pick bat la reference.')
    print('  ' + '=' * 50 + '\n')
    return 0 if not verdict else 1


if __name__ == '__main__':
    sys.exit(main())
