/**
 * sync_enrichone_columns.js — one-shot sync (PRIORITÉ 0, ÉTAPE 2 audit)
 *
 * SYNCHRONISE (ne recalcule PAS) : pour chaque match actif, la colonne
 * prediction doit refléter le pick du moteur DÉJÀ stocké dans fullData
 * (enriched.quant.main_pick || quant.main_pick || enriched.prediction).
 *
 * Pourquoi pas de recalcul : enrichOne lit m.insufficient_data comme entrée
 * (dispersion dans QuantumQuantEngine) et l'écrit `m.insufficient_data || 1`.
 * Recalculer = muter les entrées du run suivant → oscillation (12 ↔ O0.5).
 * Le sync gèle les valeurs existantes → déterministe, idempotent.
 *
 * Run:
 *   node tools/sync_enrichone_columns.js           # dry-run (par défaut)
 *   node tools/sync_enrichone_columns.js --apply   # écrit dans la DB
 *
 * Ne touche PAS les matches joués ni models/stitch_v24_hybrid.json.
 */

const database = require('../core/database')
const { marketScopeOf } = require('../core/marketScope')

const APPLY = process.argv.includes('--apply')

function pickFrom(fd) {
  // Ordre de fiabilité : quant stocké dans enriched (écrit en dernier par le
  // loop server), puis quant top-level, puis enriched.prediction/prediction.
  const enQ = (fd.enriched && fd.enriched.quant) || {}
  const topQ = fd.quant || {}
  const q = enQ.main_pick ? enQ : topQ
  const qPick = q.main_pick
  // markets : priorité au quant embarqué, sinon top-level (l'ancien enrichOne
  // stockait enriched.quant sans markets mais fd.quant.markets complet existe)
  const markets = enQ.markets || topQ.markets || null
  if (qPick) return { pick: qPick, markets }
  const ep = fd.enriched && fd.enriched.prediction
  if (ep) return { pick: ep, markets }
  const tp = fd.prediction
  if (tp) return { pick: tp, markets }
  return { pick: null, markets: null }
}

async function main() {
  const db = database.db
  if (!db) {
    console.error('No database connection')
    process.exit(1)
  }

  const ACTIVE = ['scheduled', 'upcoming', 'NOT_STARTED', 'NS']
  const rows = db
    .prepare(
      `SELECT id, prediction, fullData FROM matches WHERE status IN (${ACTIVE.map(() => '?').join(',')})`
    )
    .all(...ACTIVE)

  let toFix = 0
  let alreadyOk = 0
  let noPick = 0
  const examples = []

  for (const row of rows) {
    let fd = {}
    try {
      fd = typeof row.fullData === 'string' ? JSON.parse(row.fullData) : row.fullData || {}
    } catch (_) {
      continue
    }
    const { pick, markets } = pickFrom(fd)
    if (!pick) {
      noPick++
      continue
    }
    const scope = marketScopeOf(pick, markets)
    const storedScope = (fd.enriched && fd.enriched.market_scope) || fd.market_scope || null
    const needsFix = pick !== row.prediction || scope !== storedScope
    if (needsFix) {
      toFix++
      if (examples.length < 8)
        examples.push({ id: row.id, before: row.prediction, after: pick, scope })
      if (APPLY) {
        await database.updatePredictions(row.id, {
          prediction: pick,
          market_scope: scope,
          verdict: (fd.enriched && fd.enriched.verdict) || fd.verdict || fd.risk_label || 'PENDING',
        })
      }
    } else {
      alreadyOk++
    }
  }

  const action = APPLY ? 'APPLIED' : 'DRY-RUN'
  console.log(`[sync_enrichone_columns] ${action}`)
  console.log(`  total actifs       : ${rows.length}`)
  console.log(`  déjà cohérents     : ${alreadyOk}`)
  console.log(`  à corriger         : ${toFix}`)
  console.log(`  sans pick stocké   : ${noPick}`)
  if (examples.length) {
    console.log('  exemples:')
    for (const e of examples)
      console.log(`    - ${e.id}: prediction ${e.before} → ${e.after} (market_scope=${e.scope})`)
  }
  if (noPick > 0) console.log('  (matches sans quant.main_pick stocké — laissés tels quels)')
  if (!APPLY) console.log('  (dry-run — relancez avec --apply pour écrire)')

  process.exit(0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
