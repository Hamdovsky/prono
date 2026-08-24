/**
 * Audit étape 1 : réparation des ligues génériques polluées.
 * Réétiquette « {Pays} - {ligue} » tout match dont le label Top-5 ne correspond
 * pas au pays officiel de cette ligue (d'après fullData/category).
 * Idempotent : peut être relancé sans effet.
 *
 * Usage : node scripts/repair_league_names.js [--dry]
 */
const path = require('path')
const { applyLeaguePolicy, GENERIC_TOP5, extractCountry } = require('../core/leaguePolicy')

const root = path.join(__dirname, '..')
process.chdir(root)
const { db } = require(path.join(root, 'core', 'database'))

const dry = process.argv.includes('--dry')
const generics = Object.keys(GENERIC_TOP5)
  .map((l) => `'${l.replace(/'/g, "''")}'`)
  .join(',')

const rows = db
  .prepare(`SELECT id, homeTeam, awayTeam, league, fullData FROM matches WHERE league IN (${generics})`)
  .all()

let fixed = 0
let kept = 0
for (const row of rows) {
  const m = { ...row, fullData: row.fullData }
  const country = extractCountry(m)
  const res = applyLeaguePolicy(m)
  if (res.changed) {
    fixed++
    console.log(
      `[FIX] ${row.id} ${row.homeTeam} vs ${row.awayTeam}\n      '${row.league}' -> '${m.league}' (pays=${country})`
    )
    if (!dry) {
      db.prepare('UPDATE matches SET league = ? WHERE id = ?').run(m.league, row.id)
    }
  } else {
    kept++
  }
}

console.log(`\nScan: ${rows.length} lignes étiquetées Top-5 | réétiquetées: ${fixed}${dry ? ' (DRY RUN — rien écrit)' : ''} | inchangées (vrais Top-5): ${kept}`)
