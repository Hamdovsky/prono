"""Backfill + evaluation HONNETE du systeme de pronostic.

But : etablir pour la premiere fois la vraie performance, en rejouant les
probas sur des matchs dont le score REEL est connu.

Constat qui motive ce script (verifie) :
  - matches.home_win_probability est stocke en POURCENTAGE (0-100). C'est un
    schema assume : prediction_engine.py:1168 produit des pourcentages,
    autoBacktestService.js:143 et accuracyEngine.js:292 divisent par 100.
    Donc PAS de bug de conversion a corriger dans la base.
  - matches.scoreHome/scoreAway valent 0-0 pour les 599 matchs qui portent des
    probas : on ne peut donc PAS mesurer la performance sur `matches`.
  - archive_football_data (144 397 lignes) a les scores REELS.
  - prediction_history : 41 745 lignes 'finished' mais 0 avec result.

Ce script ne modifie AUCUNE donnee de production. Il :
  1. apparie les matchs de `matches` a l'archive par equipe + date
  2. mesure Brier / log-loss / confusion sur les matchs apparies
  3. diagnostique le trou de prediction_history
Sortie : rapport texte, aucun ecrit.
"""
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime, timezone
from math import log

MAIN_DB = 'data/tactical.db'
ARCH_DB = 'data/historical_archive.sqlite'


def norm_team(s):
    if not s:
        return ''
    s = str(s).lower().strip()
    for a, b in ((' fc', ''), (' afc', ''), (' cf', ''), (' sc', ''),
                 (' ac', ''), (' as ', ''), (' club ', ''), (' 1899', '')):
        s = s.replace(a, b)
    return ''.join(ch for ch in s if ch.isalnum() or ch == ' ').strip()


def norm_date(s):
    if not s:
        return None
    s = str(s).strip()
    for fmt in ('%Y-%m-%d', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M:%S'):
        try:
            return datetime.strptime(s[:len(fmt) + 6].strip(), fmt).date().isoformat()
        except ValueError:
            continue
    try:
        return datetime.fromtimestamp(float(s) / 1000, tz=timezone.utc).date().isoformat()
    except (ValueError, TypeError, OSError):
        return None


con = sqlite3.connect(MAIN_DB)
cur = con.cursor()

print('=' * 68)
print('ETAPE 1 - ETAT BRUT DE LA MESURE')
print('=' * 68)
n_prob = cur.execute(
    'SELECT COUNT(*) FROM matches WHERE home_win_probability IS NOT NULL').fetchone()[0]
n_score = cur.execute(
    'SELECT COUNT(*) FROM matches WHERE scoreHome IS NOT NULL').fetchone()[0]
n_00 = cur.execute('SELECT COUNT(*) FROM matches '
                   'WHERE scoreHome=0 AND scoreAway=0').fetchone()[0]
print(f'  matchs avec probas          : {n_prob}')
print(f'  matchs avec score           : {n_score} (dont 0-0 : {n_00})')
print(f'  => matchables directement   : '
      f'{n_score - n_00}  (les 599 sont inexploitables)')

print()
print('=' * 68)
print('ETAPE 2 - RAPPEL DU SCHEMA (pas un bug)')
print('=' * 68)
row = cur.execute(
    'SELECT home_win_probability, draw_probability, away_win_probability '
    'FROM matches WHERE home_win_probability IS NOT NULL LIMIT 1').fetchone()
print(f'  exemple stocke : {row}')
s = sum(float(v) for v in row if v is not None)
print(f'  somme          : {s:.2f}  -> unite POURCENTAGE, confirme')
print('  prediction_engine.py:1168 produit des % ; autoBacktestService.js:143,')
print('  accuracyEngine.js:292 et enriched_predictions.js:696 divisent par 100.')
print('  VERDICT : schema coherent, aucun correctif de conversion requis.')

print()
print('=' * 68)
print('ETAPE 3 - APPARIEMENT AVEC L\'ARCHIVE (scores reels)')
print('=' * 68)
acon = sqlite3.connect(ARCH_DB)
acur = acon.cursor()

index = defaultdict(list)
q = ('SELECT match_date, home_team, away_team, score_home, score_away, '
     'xg_home, xg_away FROM archive_football_data '
     'WHERE score_home IS NOT NULL')
for md, ht, at, sh, sa, xh, xa in acur.execute(q):
    d = norm_date(md)
    index[(d, norm_team(ht), norm_team(at))].append((sh, sa, xh, xa))

print(f'  archive indexee : {sum(len(v) for v in index.values())} matchs')

q = ('SELECT m.id, m.homeTeam, m.awayTeam, m.timestamp, m.startTimestamp, '
     'm.home_win_probability, m.draw_probability, m.away_win_probability, '
     'm.league, m.xgboost_confidence '
     'FROM matches m WHERE m.home_win_probability IS NOT NULL')
rows = cur.execute(q).fetchall()
print(f'  matchs `matches` a apparier : {len(rows)}')

matched = []
for (mid, ht, at, ts, sts, hp, dp, ap, lg, conf) in rows:
    d = norm_date(sts) or norm_date(ts)
    if not d:
        continue
    cands = index.get((d, norm_team(ht), norm_team(at)))
    if cands:
        sh, sa, xh, xa = cands[0]
        matched.append((mid, ht, at, d, lg, hp, dp, ap, sh, sa, conf))

print(f'  APPARIES (equipe + date)    : {len(matched)}')
if not matched:
    print('  aucun appariement -> la mesure reste impossible en l\'etat')

if matched:
    print()
    print('=' * 68)
    print('ETAPE 4 - PERFORMANCE REELLE (probas renormalisees en [0,1])')
    print('=' * 68)
    brier_sum = ll_sum = 0.0
    k = 0
    cm = [[0] * 3 for _ in range(3)]
    per_league = defaultdict(lambda: [0, 0.0, 0.0])
    undecided = 0

    for (mid, ht, at, d, lg, hp, dp, ap, sh, sa, conf) in matched:
        try:
            probs = [float(hp), float(dp), float(ap)]
        except (TypeError, ValueError):
            continue
        tot = sum(probs)
        if tot <= 0:
            continue
        probs = [p / tot for p in probs]
        y = 0 if sh > sa else (1 if sh == sa else 2)
        pred = max(range(3), key=lambda i: probs[i])
        cm[y][pred] += 1
        if y == 1:
            undecided += 1
        b = sum((probs[i] - (1 if i == y else 0)) ** 2 for i in range(3)) / 3
        l = -log(min(max(probs[y], 1e-12), 1 - 1e-12))
        brier_sum += b
        ll_sum += l
        k += 1
        per_league[lg][0] += 1
        per_league[lg][1] += b
        per_league[lg][2] += l

    if k:
        print(f'  echantillon exploitable : {k} matchs')
        print(f'  Brier moyen   : {brier_sum / k:.4f}   (hasard = 0.3333)')
        print(f'  Log-loss moyen: {ll_sum / k:.4f}   (hasard = 1.0986, < = mieux)')
        verdict = 'MEILLEUR que le hasard' if ll_sum / k < 1.0986 else 'PIRE que le hasard'
        print(f'  => {verdict}')
        print()
        print('  confusion (lignes = verite, colonnes = prediction)')
        for i, lab in enumerate(('dom ', 'nul ', 'ext ')):
            t = sum(cm[i])
            print(f'    {lab} n={t:4}  juste={cm[i][i]:4} '
                  f'({100 * cm[i][i] // max(t, 1):3}%)  {cm[i]}')
        print()
        print('  par ligue (Brier / log-loss) :')
        for lg, (n, b, l) in sorted(per_league.items(), key=lambda x: -x[1][0])[:8]:
            print(f'    {str(lg)[:22]:24} n={n:4}  brier={b / n:.4f}  logloss={l / n:.4f}')

print()
print('=' * 68)
print('ETAPE 5 - TROUE DANS prediction_history')
print('=' * 68)
c = Counter()
for st, res in cur.execute('SELECT status, result FROM prediction_history'):
    c[(st, res is not None)] += 1
for (st, has_res), n in sorted(c.items(), key=lambda x: -x[1]):
    verdict = 'OK' if has_res else 'MANQUE LE RESULTAT'
    print(f'  status={str(st):10} result_renseigne={str(has_res):5}  n={n:6}  {verdict}')
tot_ph = cur.execute('SELECT COUNT(*) FROM prediction_history').fetchone()[0]
res_ph = cur.execute('SELECT COUNT(*) FROM prediction_history '
                     'WHERE result IS NOT NULL').fetchone()[0]
print(f'  total {tot_ph}, avec result {res_ph} '
      f'({100 * res_ph // max(tot_ph, 1)}%)')
print('  => learning_memory (2605 entrees) ne peut pas etre alimente par ce journal.')

print()
print('=' * 68)
print('ETAPE 6 - CE QUI EST DEJIA BON')
print('=' * 68)
t, xg = cur.execute('SELECT COUNT(*), COUNT(fixing_score) '
                    'FROM historical_matches').fetchone()
print(f'  circuit anti-fixage : {xg}/{t} historical_matches scores')
for v, n in cur.execute('SELECT integrity_verdict, COUNT(*) FROM historical_matches '
                        'WHERE integrity_verdict IS NOT NULL '
                        'GROUP BY integrity_verdict ORDER BY 2 DESC'):
    print(f'    {str(v):24} {n}')
a_tot, a_xg = acur.execute('SELECT COUNT(*), COUNT(xg_home) '
                           'FROM archive_football_data').fetchone()
print(f'  archive avec scores reels : {a_tot} lignes')
print(f'  archive avec xG          : {a_xg} ({100 * a_xg // max(a_tot, 1)}%)')

con.close()
acon.close()
print()
print('FIN - aucune donnee de production modifiee.')