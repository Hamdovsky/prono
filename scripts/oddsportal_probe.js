#!/usr/bin/env node
/**
 * oddsportal_probe.js — E48 CLI dry-run (lecture seule par defaut).
 *
 * Usage :
 *   node scripts/oddsportal_probe.js                        # dry-run, toutes ligues mappees
 *   node scripts/oddsportal_probe.js --league "Serie D: Group D" --write
 *   node scripts/oddsportal_probe.js --limit 50
 *
 * --write est EXPLICITE (sinon dry-run). Aucune ecriture DB sans --write.
 */
const path = require('path')
const Database = require('better-sqlite3')

const REPO = path.join(__dirname, '..')
const DB_PATH = path.join(REPO, 'data', 'tactical.db')

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i === -1) return def
  const v = process.argv[i + 1]
  if (v == null || v.startsWith('--')) return true
  return v
}

async function main() {
  const write = !!arg('write', false)
  const limit = parseInt(arg('limit', '200'), 10)
  const leagueFilter = arg('league', null)

  const extractor = require('../services/oddsportalStatsExtractor')
  const db = new Database(DB_PATH)

  try {
    let rows = extractor.selectRows(db, { limit })
    if (typeof leagueFilter === 'string') {
      const lf = leagueFilter.toLowerCase()
      rows = rows.filter((r) => String(r.league || '').toLowerCase().includes(lf))
    }
    console.log('=== ODDSPORTAL PROBE ' + (write ? '(WRITE)' : '(DRY-RUN)') + ' ===')
    console.log('limite=' + limit + ' | matchs cibles=' + rows.length + ' | filtre=' + (leagueFilter || 'aucun'))
    const byLeague = {}
    for (const r of rows) byLeague[r.league] = (byLeague[r.league] || 0) + 1
    for (const [k, v] of Object.entries(byLeague).sort((a, b) => b[1] - a[1])) console.log('   ' + String(v).padStart(3) + '  ' + k)
    console.log('')

    if (rows.length === 0) { console.log('Rien a faire.'); process.exit(0) }

    const stats = await extractor.processScheduledMatches(db, { limit, write, log: console })

    console.log('')
    console.log('=== RESULTAT ===')
    console.log(JSON.stringify(stats, null, 2))

    const client = require('../services/oddsportalClient')
    if (client.status().running) await client.close()
  } finally {
    db.close()
  }
}

main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
