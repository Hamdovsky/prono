/**
 * backfill_context.js — E21b : hydrater match.context (ctx_v1) dans fullData
 * des matchs scheduled existants, SANS aucun appel réseau.
 *
 * Contexte : l'enrichissement (fastMode) saute les matchs « déjà enrichis »,
 * donc les lignes antérieures à E16 n'ont jamais reçu match.context -> le
 * shadow CAC du LivePredictionJournal (E16.①) reste vide en local. Ce script
 * reconstruit uniquement la partie 100 % locale du ctx_v1 :
 *   - european_next : DAO getUpcomingFixturesByTeam (ligues UEFA/CONMEBOL)
 *   - rest_hours    : DAO getHoursRest (matches terminés + historical_matches)
 *   - motivation    : labels DMF si présents sur la ligne, sinon STANDARD
 *   - absences / injury_impact : laissés null (calculés par Python via
 *     news_data quand la prédiction tourne — règle « un seul cerveau »).
 *
 * Usage : node scripts/backfill_context.js [--limit N] [--dry]
 */
require('dotenv').config()
const path = require('path')
const Database = require('better-sqlite3')

const database = require('../core/database')
const { buildMatchContext } = require('../services/contextService')

async function main() {
  const args = process.argv.slice(2)
  const limit = Number(args[args.indexOf('--limit') + 1] || 0)
  const dry = args.includes('--dry')

  const db = new Database(path.join(__dirname, '..', 'data', 'tactical.db'), { readonly: true })
  const rows = db
    .prepare(
      "SELECT id, homeTeam, awayTeam, league, startTimestamp, fullData FROM matches WHERE LOWER(COALESCE(status,''))='scheduled' ORDER BY startTimestamp ASC"
    )
    .all()
  console.log(`[BACKFILL] ${rows.length} matchs scheduled`)

  let done = 0
  let skipped = 0
  for (const row of rows) {
    if (limit && done >= limit) break
    let parsed = {}
    try {
      parsed = row.fullData ? JSON.parse(row.fullData) : {}
    } catch {
      parsed = {}
    }
    if (parsed.context && parsed.context.schema === 'ctx_v1') {
      skipped++
      continue
    }
    const m = {
      id: row.id,
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      league: row.league || parsed.league || '',
      startTimestamp: row.startTimestamp,
    }
    try {
      const ctx = await buildMatchContext(m, null, database)
      if (!ctx) {
        skipped++
        continue
      }
      if (!dry) {
        await database.mergeFullData(row.id, 'context', ctx)
      }
      done++
    } catch (e) {
      console.warn(`[BACKFILL] ${row.id} KO: ${e.message}`)
    }
    if (done % 100 === 0 && done > 0) console.log(`[BACKFILL] ${done} traites...`)
  }
  console.log(`[BACKFILL] termine: context ecrit=${done} deja_ou_incalcable=${skipped} dry=${dry}`)
  process.exit(0)
}

main().catch((e) => {
  console.error('[BACKFILL] FATAL', e)
  process.exit(1)
})
