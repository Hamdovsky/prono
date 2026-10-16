/**
 * backfill_xg.js — reconstruit les xG et le score attendu des matchs qui ont
 * des probabilités 1X2 mais aucun xG.
 *
 * POURQUOI (E105) : `expected_score` est dérivé des xG. Un match enrichi par
 * une voie qui n'écrit pas de xG (moteur d'inférence indisponible, ou verdict
 * trop peu confiant rejeté en fallback_enricher.js:202) conserve le défaut
 * Python `'1 - 1'` : un score qui n'a jamais été calculé.
 *
 * Constat au 2026-10-15 : 11 matchs réglés sur 22, soit la moitié.
 *
 * Les probabilités 1X2 constituent une information suffisante : sous Poisson
 * indépendante, (λh, λa) est déterminé par le triplet 1X2 (voir
 * core/utils/deriveXgFrom1X2).
 *
 * SÛR : le script n'écrit QUE les lignes où
 *   - le match est réglé,
 *   - `expected_score` vaut encore le placeholder '1 - 1',
 *   - `home_xg` ou `away_xg` est NULL,
 *   - les trois probabilités 1X2 sont présentes.
 * Il ne touche jamais à un match qui a déjà un xG. Idempotent.
 *
 * Usage : node scripts/backfill_xg.js          (aperçu seul, dry-run)
 *        node scripts/backfill_xg.js --apply  (écrit en base)
 */
require('dotenv').config({ quiet: true })
const path = require('path')
const { deriveXgFrom1X2, expectedScoreFromXg } = require('../core/utils/deriveXgFrom1X2')

const APPLY = process.argv.includes('--apply')
const PLAYED = "'FT','Finished','finished','FINISHED','AET','PEN'"

async function main() {
  const db = require('../core/database')
  const rows = db.db
    .prepare(
      `SELECT id, homeTeam, awayTeam, league, status, scoreHome, scoreAway,
              home_win_probability, draw_probability, away_win_probability,
              home_xg, away_xg, expected_score
         FROM matches
        WHERE status IN (${PLAYED})
          AND expected_score = '1 - 1'
          AND (home_xg IS NULL OR away_xg IS NULL)`
    )
    .all()

  console.log(`[BACKFILL-XG] ${rows.length} match(s) sans xG parmi les matchs réglés.`)
  if (rows.length === 0) {
    console.log('[BACKFILL-XG] Rien à faire.')
    if (db.db.close) db.db.close()
    return 0
  }

  const upd = db.db.prepare(
    'UPDATE matches SET home_xg = ?, away_xg = ?, expected_score = ? WHERE id = ?'
  )

  let done = 0
  let skipped = 0
  const updateTransaction = db.db.transaction((items) => {
    for (const it of items) upd.run(it.homeXg, it.awayXg, it.score, it.id)
  })
  const pending = []

  for (const m of rows) {
    const xg = deriveXgFrom1X2(
      m.home_win_probability,
      m.draw_probability,
      m.away_win_probability
    )
    if (!xg) {
      console.log(`  ⚠ ${m.id} — probabilités 1X2 absentes, ignoré`)
      skipped++
      continue
    }
    const score = expectedScoreFromXg(xg.homeXg, xg.awayXg)
    if (!score) {
      console.log(`  ⚠ ${m.id} — xG reconstruit inexploitable, ignoré`)
      skipped++
      continue
    }
    const label = `${m.homeTeam || '?'} ${m.scoreHome}-${m.scoreAway} ${m.awayTeam || '?'}`
    console.log(
      `  ${APPLY ? '✔' : '·'} ${m.id}  ${label.padEnd(38)} ` +
        `1X2 ${m.home_win_probability}/${m.draw_probability}/${m.away_win_probability} ` +
        `→ xG ${xg.homeXg.toFixed(2)} / ${xg.awayXg.toFixed(2)} → "${score}"`
    )
    pending.push({ id: m.id, homeXg: xg.homeXg, awayXg: xg.awayXg, score })
    done++
  }

  if (APPLY && pending.length > 0) {
    updateTransaction(pending)
    console.log(`[BACKFILL-XG] ${pending.length} match(s) mis à jour.`)
  } else if (pending.length > 0) {
    console.log(`[BACKFILL-XG] ${pending.length} match(s) seraient mis à jour. Relancez avec --apply.`)
  }
  if (skipped) console.log(`[BACKFILL-XG] ${skipped} ignoré(s).`)
  if (db.db.close) db.db.close()
  return 0
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error('[BACKFILL-XG] Erreur :', e.message)
    process.exit(1)
  })