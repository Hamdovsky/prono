/**
 * fetch_analyst.js — one-shot du scraper theAnalyst (Opta 1X2) (E69).
 *
 * Usage :
 *   node scripts/fetch_analyst.js                 # dry-run (aucune écriture)
 *   node scripts/fetch_analyst.js --write          # écrit dans opta_predictions
 *   node scripts/fetch_analyst.js --leagues 3      # limite le nombre de ligues
 *   node scripts/fetch_analyst.js --window 6       # horizons jours (±)
 */
const { sync, getStats } = require('../services/optaPredictions')
const database = require('../core/database')

const argv = process.argv.slice(2)
const write = argv.includes('--write')
const dry = argv.includes('--dry-run') || !write
const maxLeagues = (() => {
  const i = argv.indexOf('--leagues')
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : undefined
})()
const window = (() => {
  const i = argv.indexOf('--window')
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : undefined
})()

;(async () => {
  console.log(`[THEANALYST] mode=${dry ? 'dry-run' : 'write'} leagues=${maxLeagues ?? 'all'} window=${window ?? 4}`)
  const stats = await sync(database, { write: !dry, maxLeagues, horizonDays: window })
  console.log('[THEANALYST] stats:', JSON.stringify(stats, null, 2))
  if (!dry) {
    const g = getStats(database)
    console.log('[THEANALYST] stored total =', g.total)
  }
  process.exit(0)
})().catch((e) => {
  console.error('[THEANALYST] FATAL', e)
  process.exit(1)
})
