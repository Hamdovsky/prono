/**
 * sync_squads.js — Snapshots de valeurs d'effectifs Transfermarkt (E121).
 *
 * Proxy de chamboulement mercato : le DELTA fin-mercato (snapshot de
 * reference) vs courant alimentera le flag prudence (phase suivante).
 * 1 equipe = 1 requete (cache 6h cote service). Poli : 2 s entre equipes.
 *
 * Usage :
 *   node scripts/sync_squads.js                 # toutes les equipes mappees
 *   node scripts/sync_squads.js raja-casablanca # une seule (slug)
 */
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const db = require('../core/database')
const transfermarkt = require('../services/transfermarktService')
const { TEAM_SLUGS } = require('../services/valueBetEnricher')
const logger = require('../core/logger')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function syncOne(name, { slug, id }) {
  const info = await transfermarkt.getTeamValue(slug, id)
  const value = info && typeof info.value === 'number' ? info.value : null
  db.prepare(
    `INSERT INTO team_values (team_slug, team_id, value_eur, checked_at)
     VALUES (?, ?, ?, ?)`
  ).run(slug, String(id), value, Date.now())
  logger.info(`[SQUADS] ${name} : ${value ? value.toLocaleString() + ' €' : 'N/A'}`)
  return { name, ok: value !== null, value }
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
      logger.warn(`[SQUADS] ${name} : ${e.message}`)
      res.push({ name, ok: false, value: null })
    }
    await sleep(2000)
  }
  console.log(JSON.stringify({ ok: res.filter((r) => r.ok).length, total: res.length }))
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}

module.exports = { syncOne }
