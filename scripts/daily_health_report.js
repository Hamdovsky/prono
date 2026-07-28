/**
 * daily_health_report.js
 * Audit matinal : vérifie l'état des données, des APIs, et des prédictions.
 * Usage: node scripts/daily_health_report.js
 */
const path = require('path')
const fs = require('fs')

process.env.NODE_ENV = process.env.NODE_ENV || 'production'

const dbPath = path.join(__dirname, '..', 'data', 'tactical.db')
if (!fs.existsSync(dbPath)) {
  console.log('❌ [HEALTH] DB not found at', dbPath)
  process.exit(1)
}

const Database = require('better-sqlite3')
const db = new Database(dbPath)

const report = { date: new Date().toISOString().split('T')[0] }

// 1. Match counts
report.matches = {}
report.matches.total = db.prepare('SELECT COUNT(*) as c FROM matches').get().c
report.matches.scheduled = db
  .prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('scheduled','notstarted','NS')")
  .get().c
report.matches.finished = db
  .prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('FT','finished','Ended')")
  .get().c
report.matches.withOdds = db
  .prepare('SELECT COUNT(*) as c FROM matches WHERE odds_home IS NOT NULL')
  .get().c
report.matches.withPredictions = db
  .prepare(
    "SELECT COUNT(*) as c FROM matches WHERE expected_score IS NOT NULL AND expected_score != 'N/A'"
  )
  .get().c
report.matches.withXG = db
  .prepare('SELECT COUNT(*) as c FROM matches WHERE home_xg IS NOT NULL')
  .get().c

report.matches.today = db
  .prepare(
    "SELECT COUNT(*) as c FROM matches WHERE DATE(timestamp / 1000, 'unixepoch') = DATE('now')"
  )
  .get().c
report.matches.tomorrow = db
  .prepare(
    "SELECT COUNT(*) as c FROM matches WHERE DATE(timestamp / 1000, 'unixepoch') = DATE('now', '+1 day')"
  )
  .get().c

// 2. Check key env vars (without showing values)
const keyVars = [
  'API_SECRET_KEY',
  'GROQ_API_KEY',
  'BSD_API_KEY',
  'APIFOOTBALL_KEY',
  'SPORTMONKS_KEY',
  'FOOTBALLDATA_KEY',
  'PREDIXSPORT_API_KEY',
  'OPENWEATHER_KEY',
]
report.envKeys = {}
for (const key of keyVars) {
  report.envKeys[key] = !!process.env[key]
}

// 3. Recent errors (from logs/error.log if exists)
const errorLog = path.join(__dirname, '..', 'logs', 'error.log')
report.recentErrors = []
if (fs.existsSync(errorLog)) {
  const lines = fs
    .readFileSync(errorLog, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
  report.recentErrors = lines.slice(-10)
}

// 4. Accuracy if historical data exists
try {
  const total = db
    .prepare(
      'SELECT COUNT(*) as c FROM matches WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL AND expected_score IS NOT NULL'
    )
    .get().c
  if (total > 0) {
    const correct = db
      .prepare(
        `
      SELECT COUNT(*) as c FROM matches WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL AND expected_score IS NOT NULL
      AND (
        (SUBSTR(expected_score, 1, 1) > SUBSTR(expected_score, -1, 1) AND scoreHome > scoreAway)
        OR (SUBSTR(expected_score, 1, 1) = SUBSTR(expected_score, -1, 1) AND scoreHome = scoreAway)
        OR (SUBSTR(expected_score, 1, 1) < SUBSTR(expected_score, -1, 1) AND scoreHome < scoreAway)
      )
    `
      )
      .get().c
    report.accuracy = { total, correct, pct: ((correct / total) * 100).toFixed(1) + '%' }
  }
} catch (e) {
  report.accuracy = { error: e.message }
}

db.close()

// Print report
console.log('══════════════════════════════════════════')
console.log(`📊 HEALTH REPORT — ${report.date}`)
console.log('══════════════════════════════════════════')
console.log(`\n📅 Matchs :`)
console.log(`   Total:        ${report.matches.total}`)
console.log(`   À venir:      ${report.matches.scheduled}`)
console.log(`   Terminés:     ${report.matches.finished}`)
console.log(`   Avec cotes:   ${report.matches.withOdds}`)
console.log(`   Prédictions:  ${report.matches.withPredictions}`)
console.log(`   Avec xG:      ${report.matches.withXG}`)
console.log(`   Aujourd'hui:  ${report.matches.today}`)
console.log(`   Demain:       ${report.matches.tomorrow}`)

if (report.accuracy) {
  console.log(
    `\n🎯 Précision : ${report.accuracy.total} matchs, ${report.accuracy.correct} corrects (${report.accuracy.pct})`
  )
}

console.log(`\n🔑 APIs configurées :`)
const keysPresent = Object.entries(report.envKeys).filter(([, v]) => v)
const keysMissing = Object.entries(report.envKeys).filter(([, v]) => !v)
if (keysPresent.length > 0) {
  keysPresent.forEach(([k]) => console.log(`   ✅ ${k}`))
}
if (keysMissing.length > 0) {
  keysMissing.forEach(([k]) => console.log(`   ❌ ${k} (manquante)`))
}

if (report.recentErrors.length > 0) {
  console.log(`\n⚠️  Dernières erreurs (${report.recentErrors.length}) :`)
  report.recentErrors.forEach((l) => console.log(`   ${l.substring(0, 120)}`))
}

console.log('\n══════════════════════════════════════════')

// Exit with code based on severity
const critical = report.matches.scheduled < 10 || report.matches.withPredictions < 5
if (critical) {
  console.log('\n❌ ÉTAT CRITIQUE : pas assez de données !')
  process.exit(2)
}
if (keysMissing.length >= 5) {
  console.log('\n⚠️  ATTENTION : plus de 5 APIs non configurées')
}
console.log('\n✅ RAPPORT OK')
process.exit(0)
