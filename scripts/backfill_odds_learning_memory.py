"""Backfill des cotes DANS learning_memory.

Constat : scripts/backfill_odds_footballdata.js ecrit les cotes dans
`historical_matches` (JSON) et `matches` (colonnes), mais JAMAIS dans
`learning_memory`, ou se trouvent les probabilites et la verite terrain. Les
2 605 matchs mesurables restent donc sans cote et le ROI reste incalculable.

Or les deux tables partagent le meme identifiant : les matchs de mesure sont
en `livescore_*`, present dans les deux. On joint donc sur `id`, pas sur les
noms -- la jointure par nom+date ne trouvait que 298/1171 a cause des variantes
d'ecriture des noms entre les deux sources.

Garde : on ne propose une cote que si les trois valeurs sont > 1 (une triplete
incomplete ou une cote synthetique a 1.0 est rejetee).
"""

import json
import sqlite3
import sys

APPLY = '--apply' in sys.argv
con = sqlite3.connect('data/tactical.db')
c = con.cursor()


def j(sql, *a):
    return c.execute(sql, a).fetchall()


print('\n  === DIAGNOSTIC ===')
n_lm = j("SELECT COUNT(*) FROM learning_memory WHERE actual_1x2 IS NOT NULL AND p_home IS NOT NULL")[0][0]
print(f'  matchs mesurables dans learning_memory : {n_lm}')

# Toutes les sources de cotes disponibles, par match_id
src_hist = j("""
    SELECT id,
           json_extract(fullData,'$.odds_home'),
           json_extract(fullData,'$.odds_draw'),
           json_extract(fullData,'$.odds_away'),
           json_extract(fullData,'$.odds_source')
    FROM historical_matches
    WHERE json_extract(COALESCE(fullData,'{}'), '$.odds_home') > 1
""")
src_match = j("""
    SELECT id, odds_home, odds_draw, odds_away, odds_source
    FROM matches WHERE odds_home > 1 AND odds_draw > 1 AND odds_away > 1
""")
print(f'  cotes dans historical_matches : {len(src_hist)}')
print(f'  cotes dans matches           : {len(src_match)}')

best = {}
rejete = 0

# ODDS_REJECT_SYNTHETIC=on (deja dans .env, appliquee par scrapeService.js:390) :
# une cote synthetique n'est PAS une cote de marche. La compter comme telle
# fausserait le ROI -- c'est exactement ce que ce flag existe pour empecher.
# Meme raisonnement pour `fair_odds_model` : c'est une sortie de modele, pas un
# prix de marche. Seules les sources reelles (exchange, bookmaker, agrégateur)
# sont retenues ici.
NON_REELLES = ('synthetic', 'fair_odds_model', 'model', 'bridge', 'derived')


def source_reelle(s):
    t = str(s or '').strip().lower()
    return t not in NON_REELLES and not any(bad in t for bad in NON_REELLES)


for mid, oh, od, oa, s in src_hist:
    if oh and od and oa and min(oh, od, oa) > 1:
        if not source_reelle(s):
            rejete += 1
            continue
        best[mid] = (oh, od, oa, s or 'footballdata')
for mid, oh, od, oa, s in src_match:
    if mid not in best and oh and od and oa and min(oh, od, oa) > 1:
        if not source_reelle(s):
            rejete += 1
            continue
        best[mid] = (oh, od, oa, s or 'matches')
print(f'  union par match_id : {len(best)} matchs avec cote 1X2 exploitable')
print(f'  ecartees (source synthetique / modele) : {rejete}')

print('\n  === JOINTURE AVEC LE BACKLOG DE MESURE ===')
hit = j("SELECT match_id FROM learning_memory WHERE actual_1x2 IS NOT NULL AND p_home IS NOT NULL")
hit_ids = {r[0] for r in hit}
joinable = [m for m in best if m in hit_ids]
print(f'  matchs de mesure presents dans une source de cotes : {len(joinable)}')

sources = {}
for m in joinable:
    sources[best[m][3]] = sources.get(best[m][3], 0) + 1
for k, v in sorted(sources.items(), key=lambda x: -x[1]):
    print(f'    {k:<28} {v}')

if not APPLY:
    print('\n  DRY-RUN — relancer avec --apply\n')
    for m in joinable[:8]:
        oh, od, oa, s = best[m]
        row = c.execute('SELECT home_team, away_team FROM learning_memory WHERE match_id=?',
                        (m,)).fetchone()
        print(f"    {(row[0] + ' vs ' + row[1])[:40]:<40} {oh:5.2f}/{od:5.2f}/{oa:5.2f}  {s}")
    raise SystemExit(0)

n = 0
for m in joinable:
    oh, od, oa, s = best[m]
    c.execute('UPDATE learning_memory SET odds_home=?, odds_draw=?, odds_away=? WHERE match_id=?',
              (oh, od, oa, m))
    n += 1
con.commit()

done = c.execute("""
    SELECT COUNT(*) FROM learning_memory
    WHERE odds_home > 1 AND odds_draw > 1 AND odds_away > 1""").fetchone()[0]
print(f'\n  ecrites : {n}')
print(f'  learning_memory avec cote 1X2 : {done}/{n_lm} '
      f'({100 * done / n_lm:.1f}% des matchs mesurables)\n')