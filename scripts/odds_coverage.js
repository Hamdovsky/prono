/**
 * odds_coverage.js — telemetry LECTURE SEULE de la couverture en vraies cotes des
 * matchs a jouer (status='scheduled' a venir). Reutilise le predicat officiel
 * (core/oddsSource) => le meme critere que le filtre de picks / gate CLV.
 *
 * But (Chantier rentabilite, Etape 3) : baseline reutilisable pour mesurer CHAQUE
 * levier d'elargissement (whitelist, sources, FD per-season...).
 *
 * Usage : node scripts/odds_coverage.js [--days=7]
 */
const path = require('path')
const REPO = path.join(__dirname, '..')
const Database = require('better-sqlite3')
const { isRealBookmakerSource } = require(REPO + '/core/oddsSource')

const DAYS = Number((process.argv.find((a) => a.startsWith('--days=')) || '--days=7').split('=')[1])
const db = new Database(REPO + '/data/tactical.db', { readonly: true })
const now = Date.now()
const horizon = now + DAYS * 86400000

function num(v) { const f = parseFloat(v); return !isNaN(f) && f > 1 ? f : null }

const rows = db.prepare(`SELECT id, league, odds_home, odds_draw, odds_away, odds_over25, odds_under25, odds_btts_yes, odds_source, fullData, startTimestamp, timestamp FROM matches WHERE status='scheduled'`).all()

let upcoming = 0, with1x2 = 0, real1x2 = 0, synthetic = 0, none = 0, realOu = 0, realBtts = 0
const bySrc = {}
const leagues = {}
for (const r of rows) {
  let ts = Number(r.startTimestamp || 0); if (ts > 0 && ts < 1e12) ts *= 1000
  if (!ts && r.timestamp) { const p = Date.parse(r.timestamp); if (!isNaN(p)) ts = p }
  const future = ts > now - 3600000 && ts <= horizon
  const src = (r.odds_source || '').trim()
  bySrc[src || '(null)'] = (bySrc[src || '(null)'] || 0) + 1
  const numeric = num(r.odds_home) && num(r.odds_draw) && num(r.odds_away)
  const realSrc = isRealBookmakerSource(src)
  if (future) {
    upcoming++
    if (numeric) with1x2++
    if (numeric && realSrc) real1x2++
    else if (numeric && !realSrc) synthetic++
    else none++
    if (num(r.odds_over25) && num(r.odds_under25) && realSrc) realOu++
    if (num(r.odds_btts_yes) && realSrc) realBtts++
    if (!realSrc || !numeric) { leagues[r.league || '?'] = (leagues[r.league || '?'] || 0) + 1 }
  }
}
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—')
console.log(`[odds_coverage] horizon ${DAYS}j  |  scheduled a venir=${upcoming}`)
console.log(`  1X2 numerique          : ${with1x2} (${pct(with1x2, upcoming)})`)
console.log(`    -> VRAIE cote 1X2    : ${real1x2} (${pct(real1x2, upcoming)})   <-- l'indicateur de couverture utile`)
console.log(`    -> synthetique       : ${synthetic} (${pct(synthetic, upcoming)})  (fair_odds_model/...) a exclure`)
console.log(`    -> aucune            : ${none} (${pct(none, upcoming)})`)
console.log(`  vraie cote O/U 2.5     : ${realOu} (${pct(realOu, upcoming)})`)
console.log(`  vraie cote BTTS        : ${realBtts} (${pct(realBtts, upcoming)})`)
console.log(`\n  [odds_source] ${JSON.stringify(bySrc)}`)
const topSkip = Object.entries(leagues).sort((a, b) => b[1] - a[1]).slice(0, 12)
console.log(`\n  ligues les plus NON couvertes (defaut/synth/absent) :`)
for (const [lg, n] of topSkip) console.log(`     ${String(n).padStart(3)}  ${lg}`)
db.close()
