"""E76 — marque l'origine des cotes déjà enregistrées dans `bets`.

Décision utilisateur : marquer sans purger. On ne réécrit pas l'historique, on
le rend lisible : `odds_source` distingue un prix de marché d'un prix de repli,
et les calculs financiers ne prennent que les lignes 'reelle'.

Détection des lignes existantes (valeurs, pas de colonne disponible) :
  repli = odds IN (1.0, 1.2, 2.0)
    1.00 -> pick « 12 » dérivé de h=a=2 : 1/(1/2+1/2). Une vraie cote de double
            chance « 12 » vaut 1/somme des probs implicites < 1, donc jamais 1.00.
    1.20 -> pick « 1X »/« X2 » dérivé de h=2, d=3 : 1/(1/2+1/3).
    2.00 -> repli `|| 2` de settlementService.
La signature 1.00/1.20 est sans ambiguïté (une vraie cote double chance est un
nombre non rond). Pour 2.00, un vrai prix rond est possible en théorie : le
repli en est la cause dominante et un prix exactement 2.00 resterait inexploitable
pour un ROI fin — c'est documenté dans routes/bets.js.

Sauvegarde avant écriture, comme les autres backfills : %TEMP%\tactical_backup_pre_odds_source.db
"""

import os
import shutil
import sqlite3
import sys
import tempfile

APPLY = '--apply' in sys.argv
DB = 'data/tactical.db'

con = sqlite3.connect(DB)
c = con.cursor()

have = {r[1] for r in c.execute('PRAGMA table_info(bets)')}
missing = 'odds_source' not in have
if missing:
    if not APPLY:
        print('\n  bets.odds_source ABSENTE.')
        print('  core/db/schema.js la declare et la migration ALTER de schema.js')
        print('  l\'ajoute au demarrage du serveur ; sur cette base locale ancienne,')
        print('  elle n\'existe pas encore. Relancer avec --apply pour l\'ajouter')
        print('  (sauvegarde prealable) puis marquer les lignes.\n')
        raise SystemExit(0)
    dest = os.path.join(tempfile.gettempdir(), 'tactical_backup_pre_odds_source.db')
    shutil.copy2(DB, dest)
    print(f'\n  sauvegarde : {dest}')
    # SANS DEFAULT : sinon les 11 994 lignes a cote de repli seraient d'emblee
    #Etiquetees 'reelle' par SQLite, et le backfill n'aurait plus rien a faire.
    c.execute('ALTER TABLE bets ADD COLUMN odds_source TEXT')
    con.commit()
    print('  colonne bets.odds_source ajoutee (sans DEFAULT, volontairement)')

n = c.execute('SELECT COUNT(*) FROM bets').fetchone()[0]
deja = c.execute("SELECT COUNT(*) FROM bets WHERE odds_source IS NOT NULL").fetchone()[0]
print('\n  === ETAT ===')
print(f'  lignes bets                     : {n}')
print(f'  deja marquees                   : {deja}')
print(f'  a marquer                       : {n - deja}')

if not APPLY:
    print('\n  DRY-RUN — relancer avec --apply\n')
    for r in c.execute("""SELECT odds, COUNT(*) n FROM bets
                          WHERE odds_source IS NULL AND odds IN (1.0,1.2,2.0)
                          GROUP BY odds ORDER BY n DESC"""):
        print(f'    {r[0]:>5} -> repli   ({r[1]} lignes)')
    for r in c.execute("""SELECT odds, COUNT(*) n FROM bets
                          WHERE odds_source IS NULL
                            AND (odds IS NULL OR odds NOT IN (1.0,1.2,2.0))
                          GROUP BY odds ORDER BY n DESC LIMIT 5"""):
        print(f'    {r[0]:>5} -> reelle  ({r[1]} lignes)')
    raise SystemExit(0)

if not missing:
    dest = os.path.join(tempfile.gettempdir(), 'tactical_backup_pre_odds_source.db')
    shutil.copy2(DB, dest)
    print(f'\n  sauvegarde : {dest}')

c.execute("""UPDATE bets SET odds_source = 'repli'
             WHERE odds_source IS NULL AND odds IN (1.0,1.2,2.0)""")
n_repli = c.rowcount
c.execute("""UPDATE bets SET odds_source = 'absente'
             WHERE odds_source IS NULL AND odds IS NULL""")
n_abs = c.rowcount
c.execute("""UPDATE bets SET odds_source = 'reelle'
             WHERE odds_source IS NULL AND odds IS NOT NULL
               AND odds NOT IN (1.0,1.2,2.0)""")
n_reel = c.rowcount
con.commit()

print(f'  marquees repli   : {n_repli}')
print(f'  marquees reelle  : {n_reel}')
print(f'  marquees absente : {n_abs}')
print('\n  === VERIFICATION (paris REGLES uniquement) ===')
print('  un pari pending n\'est ni gain ni perte : le compter comme une perte')
print('  fausserait le P&L.')
for r in c.execute("""SELECT COALESCE(odds_source,'(null)') s,
                             SUM(stake) staked,
                             SUM(CASE WHEN result='won' THEN stake*odds ELSE 0 END) returned,
                             COUNT(*) n
                      FROM bets WHERE result IN ('won','lost')
                      GROUP BY odds_source ORDER BY n DESC"""):
    pnl = r[2] - r[1]
    roi = (pnl / r[1] * 100) if r[1] else 0
    print(f'  {r[0]:<10} n={r[3]:<6} mises={r[1]:<10.2f} P&L={pnl:>10.2f}  ROI={roi:>7.2f}%')
print()
print('  -> seul "reelle" compte pour un ROI financier. Les autres colonnes sont')
print('     conservees pour l\'historique, pas pour l\'affichage.')