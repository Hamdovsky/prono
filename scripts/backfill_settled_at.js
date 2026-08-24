/**
 * Audit étape B : backfill one-shot de settled_at.
 * Les lignes déjà settlées avant le fix updateMatchResult ont settled_at=NULL.
 * Proxy honnête : last_updated = moment de la dernière maj (pose du résultat).
 * Idempotent. Usage : node scripts/backfill_settled_at.js [--dry]
 */
const path = require('path')
const root = path.join(__dirname, '..')
process.chdir(root)
const { db } = require(path.join(root, 'core', 'database'))

const dry = process.argv.includes('--dry')
// Proxy temporel du settle par table. Garde stricte : ne toucher QUE les
// lignes dont le statut prouve un match joué (leçon du 24/08 : scoreHome=0
// est la valeur par défaut d'insertion, pas une preuve de settle).
const tables = [
  { name: 'matches', proxy: 'last_updated', guard: "status IN ('finished','FT')" },
  { name: 'historical_matches', proxy: 'archived_at', guard: null },
]

for (const { name: t, proxy } of tables) {
  let cols = []
  try {
    cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
  } catch (_) {}
  const missing = ['settled_at', 'scoreHome', proxy].filter((c) => !cols.includes(c))
  if (missing.length) {
    console.log(`[${t}] colonnes manquantes (${missing.join(', ')}) — ignoré`)
    continue
  }
  const where = `scoreHome IS NOT NULL AND settled_at IS NULL AND ${proxy} IS NOT NULL${guard ? ` AND ${guard}` : ''}`
  const row = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${where}`).get()
  console.log(`[${t}] lignes à backfiller : ${row.n} (proxy=${proxy}${guard ? `, garde=${guard}` : ``})`)
  if (!dry && row.n > 0) {
    const r = db.prepare(`UPDATE ${t} SET settled_at = ${proxy} WHERE ${where}`).run()
    console.log(`[${t}] backfilled : ${r.changes}`)
  }
}
console.log(dry ? '\nDRY RUN — rien écrit.' : '\nTerminé.')
