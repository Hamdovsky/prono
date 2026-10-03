"""E80 — le programme est-il pret a produire de bons pronostics ?

E79 a tranche pour le 1X2 : sur 13 915 matchs, AUC de 0,508 / 0,522 / 0,510
et un pick significativement moins bon que « toujours domicile ». Restait a
faire le meme examen sur les autres marches, sans quoi la reponse « non » ne
serait vraie que pour le 1X2.

Marches mesures, et sur quoi :

  1X2      prediction_history, 13 915 matchs, les 3 issues, verite terrain
  DC        derive des memes probabilites (1X = P(H)+P(D), etc.)
  OU 2.5    matches.ou_25_prob, matchs termines seulement
  BTTS      matches.btts_prob, matchs termines seulement

Un marche n'est « pret » que si les trois conditions sont reunies :

  A. CALIBRATION     la frequence reelle suit la proba annoncee (5 points max)
  B. DISCRIMINATION  AUC >= 0,55
  C. PICK            le pick bat la regle sans information, au sens de McNemar

Sans C, un marche « performant » ne fait queencaisser la cote : une double
chance gagne ~66 % des fois par sa seule structure de paris, sans aucune
prevision. C'est le piege classique, et c'est exactement ce que DC doit
subir.

Corners n'apparait pas : aucune probabilite de corners n'est stockee. Non
mesurable, donc non declare pret.

⚠️ Piège déjà payé une fois dans ce diagnostic : la table `matches` contient
1 575 lignes de score 0-0 sur 1 813, dont 1 397 matchs encore `scheduled`.
Évaluer OU 2.5 ou BTTS dessus donne 92 % de « sous 2,5 buts » et 92,8 % de
« BTTS non », qui sont des scores placeholder, pas du football. D'ou le filtre
`status='finished'` ET score non nul, applique plus bas.

Usage : .venv/Scripts/python.exe scripts/eval_markets_readiness.py
Sortie : 0 si au moins un marche est pret, 1 sinon.
"""
import math
import sqlite3
import sys

DB = 'data/tactical.db'
MIN_AUC = 0.55
CAL_TOL = 0.05
MIN_N = 300
NAMES = ('domicile', 'nul', 'exterieur')


def norm_cdf(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


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


def mcnemar_joint(pairs):
    """pairs = (pick_correct, base_correct) par observation.
    a = pick reussi et reference ratee, b = reference reussie et pick rate."""
    a = sum(1 for pc, bc in pairs if pc and not bc)
    b = sum(1 for pc, bc in pairs if bc and not pc)
    if a + b == 0:
        return 1.0, a, b
    chi2 = (abs(a - b) - 1) ** 2 / (a + b)
    return 2 * (1 - norm_cdf(math.sqrt(max(chi2, 0.0)))), a, b


def report(label, n, probs, outcomes, sides):
    """probs[i] = probabilite annoncee du cote i ; outcomes = 0/1 reel.
    Accepte un vecteur binaire ou une liste de vecteurs (1X2)."""
    if outcomes and not isinstance(outcomes[0], (list, tuple)):
        outcomes = [[o, 1 - o] for o in outcomes]
    n = len(outcomes)
    if n < MIN_N:
        print(f'  {label} : n = {n}, echantillon trop petit pour conclure\n')
        return {'label': label, 'n': n, 'ready': False, 'auc': float('nan'),
                'cal': False, 'disc': False, 'pick': False}
    print(f'  {label}   (n = {n})')
    a_all = []
    cal_ok = True
    for i, s in enumerate(sides):
        scores = [p[i] for p in probs]
        labels = [o[i] for o in outcomes]
        a, se = auc(scores, labels)
        z = (a - 0.5) / se if se else 0.0
        a_all.append(a)
        mean_p = sum(scores) / n
        real_p = sum(labels) / n
        gap = mean_p - real_p
        if abs(gap) > CAL_TOL:
            cal_ok = False
        print(f'     {s:<9} annonce {mean_p * 100:5.1f} %   reel '
              f'{real_p * 100:5.1f} %   ecart {gap * 100:+5.1f} pts   '
              f'AUC {a:.3f} +/- {se:.3f}  z = {z:+.1f}')
    mean_auc = sum(a_all) / len(a_all)
    truth = [max(range(len(sides)), key=lambda i: o[i]) for o in outcomes]
    ll = -sum(math.log(max(p[truth[k]], 1e-12))
              for k, p in enumerate(probs)) / n
    br = sum((p[truth[k]] - 1) ** 2 for k, p in enumerate(probs)) / n
    print(f'     AUC moyenne {mean_auc:.3f}   log-loss {ll:.4f}   '
          f'Brier {br:.4f}')

    idx = range(len(sides))
    pick = [max(idx, key=lambda i: p[i]) for p in probs]
    best = max(idx, key=lambda i: sum(o[i] for o in outcomes))
    hit = sum(1 for k, q in enumerate(pick) if outcomes[k][q] == 1)
    base_hit = sum(o[best] for o in outcomes)
    p_mc, a, b = mcnemar_joint([(outcomes[k][q] == 1, outcomes[k][best] == 1)
                                for k, q in enumerate(pick)])
    print(f'     pick {hit / n * 100:.1f} %   reference "{sides[best]}" '
          f'{base_hit / n * 100:.1f} %')
    print(f'     McNemar {a}/{b}  p = {p_mc:.4f}  '
          f'{"SIGNIFICATIF" if p_mc < 0.05 else "non significatif"}')
    disc_ok = mean_auc >= MIN_AUC
    pick_ok = (hit > base_hit and p_mc < 0.05)
    ready = disc_ok and pick_ok and cal_ok
    print(f'     -> calibration {"OK" if cal_ok else "NON"} | '
          f'discrimination {"OK" if disc_ok else "NON"} | '
          f'pick {"OK" if pick_ok else "NON"} | '
          f'{"PRET" if ready else "PRET NON"}\n')
    return {'label': label, 'n': n, 'auc': mean_auc, 'cal': cal_ok,
            'disc': disc_ok, 'pick': pick_ok, 'ready': ready,
            'acc': hit / n, 'base': base_hit / n, 'p': p_mc}


def load_1x2():
    con = sqlite3.connect(DB)
    rows = con.execute(
        "SELECT match_id, prediction_type, probability, result"
        " FROM prediction_history WHERE result IS NOT NULL"
        " AND probability IS NOT NULL"
    ).fetchall()
    con.close()
    T = ('Home', 'Draw', 'Away')
    by = {}
    for mid, t, p, r in rows:
        by.setdefault(mid, {})[t] = (float(p), r)
    out = []
    for d in by.values():
        if any(t not in d for t in T):
            continue
        w = [t for t in T if d[t][1] == 'won']
        if len(w) != 1:
            continue
        s = sum(d[t][0] for t in T)
        if s <= 0:
            continue
        i = T.index(w[0])
        out.append(([d[t][0] / s for t in T], [1 if k == i else 0 for k in range(3)]))
    return out


def load_binary_market(col, outcome_fn):
    """VRAIE verite terrain, sur le gros corpus.

    Les probabilites OU/BTTS ne sont pas des colonnes : elles vivent dans
    `historical_matches.fullData` (13 516 matchs), alors que la table `matches`
    n'en a que 232 avec un score reellement termine. D'ou l'usage du fullData.

    La table `matches` a deja produit une fausse alerte (92 % de « sous 2,5
    buts ») parce que 1 575 de ses 1 813 lignes ont un score 0-0 placeholder et
    1 397 matchs sont encore `scheduled`. On ne mesure plus dessus.
    """
    import json
    con = sqlite3.connect(DB)
    rows = con.execute(
        "SELECT fullData, scoreHome, scoreAway FROM historical_matches"
        " WHERE fullData IS NOT NULL AND scoreHome IS NOT NULL"
        " AND scoreAway IS NOT NULL"
    ).fetchall()
    con.close()
    pr, ou = [], []
    for fd, sh, sa in rows:
        try:
            d = json.loads(fd)
        except Exception:
            continue
        v = d.get(col)
        if v is None:
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if v > 1.0:
            v /= 100.0
        if not 0.0 < v < 1.0:
            continue
        pr.append([v, 1.0 - v])
        ou.append(outcome_fn(sh, sa))
    return pr, ou


def main():
    res = []

    print('\n  1X2   (prediction_history, 3 issues, verite terrain)')
    print('  ' + '-' * 72)
    d = load_1x2()
    res.append(report('1X2', len(d), [p for p, _ in d], [o for _, o in d], NAMES))

    print('  DC    (derive des probabilites 1X2)')
    print('  ' + '-' * 72)
    sides = ('1X', '12', 'X2')
    buckets = {k: ([], []) for k in sides}
    for p, o in d:
        for k, (a, b) in zip(sides, ((0, 1), (0, 2), (1, 2))):
            v = p[a] + p[b]
            buckets[k][0].append([v, 1.0 - v])
            buckets[k][1].append(1 if o[a] or o[b] else 0)
    best_dc = None
    for k in sides:
        pr, ou = buckets[k]
        r = report(f'DC {k}', len(ou), pr, ou, ('oui', 'non'))
        if best_dc is None or (r['auc'] == r['auc']
                               and r['auc'] > best_dc['auc']):
            best_dc = r
    res.append(best_dc)

    print('  OU 2.5   (historical_matches.fullData + score reel)')
    print('  ' + '-' * 72)
    pr, ou = load_binary_market('ou_25_prob',
                                lambda sh, sa: int(sh) + int(sa) > 2.5)
    res.append(report('OU 2.5', len(ou), pr, ou, ('OVER', 'UNDER')))

    print('  BTTS   (historical_matches.fullData + score reel)')
    print('  ' + '-' * 72)
    pr, ou = load_binary_market(
        'btts_prob', lambda sh, sa: 1 if (int(sh) > 0 and int(sa) > 0) else 0)
    res.append(report('BTTS', len(ou), pr, ou, ('OUI', 'NON')))

    print('  Corners : NON MESURABLE')
    print('  ' + '-' * 72)
    con = sqlite3.connect(DB)
    n = con.execute("SELECT COUNT(*) FROM matches"
                    " WHERE corners_home IS NOT NULL").fetchone()[0]
    con.close()
    print(f'     corners reels stocks : {n} lignes')
    print('     aucune probabilite de corners stockee => aucune prevision')
    print('     a evaluer -> ni pret, ni disprove\n')

    ok = [r for r in res if r and r['ready']]
    print('  ' + '=' * 72)
    print('  SYNTHESE')
    print('  ' + '=' * 72)
    for r in res:
        if not r:
            continue
        aucs = ('%.3f' % r['auc']) if r['auc'] == r['auc'] else '  n/a'
        verdict = 'PRET' if r['ready'] else 'PRET NON'
        print(f'  {r["label"]:<10} n={r["n"]:<6} AUC {aucs}   {verdict}')
    print()
    if ok:
        print('  MARCHES PRETS :', ', '.join(r['label'] for r in ok))
    else:
        print('  AUCUN MARCHE NE REMPLIT LES TROIS CONDITIONS.')
    print('  ' + '=' * 72)
    print("""
  Rappel : un marche qui gagne 65 % sans modele (double chance) n'est pas un
  marche qui fonctionne, c'est un marche facile. Ce qui compte est l'ecart au
  taux de reussite sans information, pas le taux de reussite.""")
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
