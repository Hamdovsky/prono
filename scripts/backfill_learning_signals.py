"""Backfill E73 sur learning_memory (idempotent, dry-run par defaut).

Remplit :
  actual_1x2 : derive du score (H/D/A) - sans risque, source primaire
  p_home/p_draw/p_away : jointes depuis prediction_history (les 3 lignes par
    match_id portent chacune leur probabilite, deja en [0,1] - somme verifiee)
  odds_* : depuis learning_memory.context si les cotes y sont presentes,
    sinon laissees NULL (mieux vaut un trou qu'une invention)

`result` est le sort du PICK, pas le resultat du match : on ne l'utilise PAS
pourDeriver actual_1x2, ce serait recreer la boucle circulaire constatee en E72.

Usage :
  python scripts/backfill_learning_signals.py --dry-run   (defaut)
  python scripts/backfill_learning_signals.py --apply
"""

import argparse
import json
import re
import sqlite3

DB = 'data/tactical.db'


def parse_score(score):
    if not score:
        return None
    m = re.match(r'^\s*(\d+)\s*-\s*(\d+)\s*$', str(score))
    if not m:
        return None
    sh, sa = int(m.group(1)), int(m.group(2))
    return 'H' if sh > sa else ('A' if sh < sa else 'D')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default=DB)
    ap.add_argument('--apply', action='store_true',
                    help='ecrit les modifications (sinon dry-run)')
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    cur = con.cursor()

    total = cur.execute('SELECT COUNT(*) FROM learning_memory').fetchone()[0]
    print(f'entrees learning_memory : {total}')
    if not args.apply:
        print('MODE DRY-RUN (--apply pour ecrire)\n')

    # --- actual_1x2 depuis le score ---
    upd_a = 0
    for mid, score in cur.execute(
            'SELECT match_id, score FROM learning_memory').fetchall():
        truth = parse_score(score)
        if truth:
            cur.execute('UPDATE learning_memory SET actual_1x2=? WHERE match_id=?',
                        (truth, mid))
            upd_a += 1

    # --- probabilites depuis prediction_history ---
    # On ne garde que les match_id presents dans learning_memory : prediction_history
    # en contient 13915, learning_memory 2605. Sans ce filtre on "met a jour"
    # 13915 lignes qui n'existent pas (no-op silencieux) et on afficherait un
    # chiffre faux.
    lm_ids = {m[0] for m in cur.execute('SELECT match_id FROM learning_memory')}
    probs = {}
    for (mid, ph, pd_, pa) in cur.execute("""
        SELECT match_id,
               MAX(CASE WHEN prediction_type='Home' THEN probability END),
               MAX(CASE WHEN prediction_type='Draw' THEN probability END),
               MAX(CASE WHEN prediction_type='Away' THEN probability END)
        FROM prediction_history
        WHERE status='finished' AND probability IS NOT NULL
        GROUP BY match_id
    """):
        if mid not in lm_ids:
            continue
        if ph is None or pd_ is None or pa is None:
            continue
        try:
            vals = [float(ph), float(pd_), float(pa)]
        except (TypeError, ValueError):
            continue
        tot = sum(vals)
        # prediction_history stocke deja en [0,1] ; on renormalise par prudence
        if tot <= 0:
            continue
        probs[mid] = [v / tot for v in vals]

    upd_p = 0
    for mid, (ph, pd_, pa) in probs.items():
        cur.execute('UPDATE learning_memory SET p_home=?, p_draw=?, p_away=? '
                    'WHERE match_id=?', (ph, pd_, pa, mid))
        upd_p += 1

    # --- cotes : presentes dans le contexte JSON ? ---
    upd_o = 0
    for mid, ctx in cur.execute(
            'SELECT match_id, context FROM learning_memory '
            'WHERE context IS NOT NULL').fetchall():
        try:
            d = json.loads(ctx)
        except (TypeError, ValueError):
            continue
        if not isinstance(d, dict):
            continue
        src = d.get('oddsData') if isinstance(d.get('oddsData'), dict) else d
        h, d2, a = src.get('home'), src.get('draw'), src.get('away')
        vals = []
        for v in (h, d2, a):
            try:
                vals.append(float(v))
            except (TypeError, ValueError):
                vals.append(None)
        if all(v is not None and v > 1 for v in vals):
            cur.execute('UPDATE learning_memory SET odds_home=?, odds_draw=?, '
                        'odds_away=? WHERE match_id=?',
                        (vals[0], vals[1], vals[2], mid))
            upd_o += 1

    print(f'actual_1x2  mis a jour : {upd_a}')
    print(f'p_*         mis a jour : {upd_p}')
    print(f'odds_*      mis a jour : {upd_o}')

    # Verification AVANT toute decision de commit/rollback : apres rollback les
    # colonnes sont vides et le compteur mentirait sur l'effet reel.
    cur.execute("""
        SELECT COUNT(*) FROM learning_memory
        WHERE actual_1x2 IS NOT NULL AND p_home IS NOT NULL
    """)
    mesurable = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM learning_memory WHERE actual_1x2 IS NOT NULL")
    avec_verite = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM learning_memory WHERE p_home IS NOT NULL")
    avec_probas = cur.fetchone()[0]

    print(f'\n  verite terrain (actual_1x2) : {avec_verite}/{total}')
    print(f'  probabilites (p_*)          : {avec_probas}/{total}')
    print(f'  MATCHS MESURABLES           : {mesurable}/{total}')

    if args.apply:
        con.commit()
        print('\nECRIT et valide.')
    else:
        con.rollback()
        print('\nrollback (dry-run). Relancer avec --apply.')

    con.close()


if __name__ == '__main__':
    main()