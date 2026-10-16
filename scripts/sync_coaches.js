/**
 * sync_coaches.js — Remplit `coach_history` depuis Transfermarkt (E119).
 *
 * 1 equipe = 1 requete HTTP (cache 7j cote service). Poli : 2 s entre equipes.
 * Idempotent (UNIQUE team_id/manager/appointed).
 *
 * Usage :
 *   node scripts/sync_coaches.js                    # toutes les equipes mappees
 *   node scripts/sync_coaches.js manchester-city     # une seule (slug)
 */
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const db = require('../core/database')
const transfermarkt = require('../services/transfermarktService')
const { TEAM_SLUGS } = require('../services/valueBetEnricher')
const logger = require('../core/logger')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function syncOne(name, { slug, id }) {
  const hist = await transfermarkt.getManagerHistory(slug, id)
  if (!hist || hist.length === 0) {
    logger.warn(`[COACHES] ${name} : rien parsable (structure changee ?)`)
    return { name, ok: false, n: 0 }
  }
  const now = Date.now()
  let n = 0
  for (const c of hist) {
    try {
      db.prepare(
        `INSERT OR IGNORE INTO coach_history
         (team_slug, team_id, manager, appointed, ended, matches, ppg, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(slug, String(id), c.name, c.appointed, c.ended, c.matches, c.ppg, now)
      n++
    } catch (e) {
      logger.warn(`[COACHES] insert ${name}/${c.name}: ${e.message}`)
    }
  }
  const current = hist.find((c) => c.current)
  logger.info(`[COACHES] ${name} : ${hist.length} coach(es), actuel=${current ? current.name : '?'}`)
  return { name, ok: true, n, current: current ? current.name : null }
}

async function main() {
  const only = process.argv[2]
  const entries = Object.entries(TEAM_SLUGS || {}).filter(([name, v]) => {
    if (!only) return true
    return v.slug === only || name.toLowerCase() === only.toLowerCase()
  })
  if (entries.length === 0) {
    console.error(`Aucune equipe pour filtre '${only}'`)
    process.exit(1)
  }
  const res = []
  for (const [name, v] of entries) {
    try {
      res.push(await syncOne(name, v))
    } catch (e) {
      logger.warn(`[COACHES] ${name} : ${e.message}`)
      res.push({ name, ok: false, n: 0 })
    }
    await sleep(2000)
  }
  console.log(JSON.stringify({ ok: res.filter((r) => r.ok).length, total: res.length, res }, null, 1))
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}

module.exports = { syncOne }
