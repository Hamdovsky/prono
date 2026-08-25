/**
 * diag_free_path.js — Diagnostic read-only du chemin gratuit.
 * Teste chaque source gratuite indépendamment et affiche un tableau de statut.
 * Aucune écriture en base (on n'appelle que les méthodes fetch/odds).
 */
require('dotenv').config()
const { execSync } = require('child_process')
const path = require('path')

const today = new Date().toISOString().split('T')[0]
const log = (...a) => console.log(...a)
const line = (c) => '─'.repeat(c)

async function main() {
  log('\n' + line(70))
  log('🔎 DIAGNOSTIC CHEMIN GRATUIT — ' + new Date().toISOString())
  log('   Date test   : ' + today)
  log('   DISABLE_SOFASCORE = ' + process.env.DISABLE_SOFASCORE)
  log(line(70))

  const results = {}

  // 1. OpenLigaDB
  try {
    const svc = require('../services/openligadbService')
    const ev = await svc.fetchEvents(today)
    results.openligadb = { ok: true, count: ev.length, sample: ev[0] ? `${ev[0].homeTeam} vs ${ev[0].awayTeam}` : null }
  } catch (e) {
    results.openligadb = { ok: false, error: e.message }
  }

  // 2. SportScore
  try {
    const svc = require('../services/sportScoreService')
    const sched = await svc.fetchScheduledEvents()
    results.sportscore = { ok: true, scheduled: sched.length, sample: sched[0] ? `${sched[0].homeTeam} vs ${sched[0].awayTeam}` : null }
  } catch (e) {
    results.sportscore = { ok: false, error: e.message }
  }

  // 3. BetExplorer bypass (curl_cffi python)
  try {
    const svc = require('../services/scrapers/ScrapingBypassScraper')
    const odds = await svc.getOdds('Bayern Munich', 'Borussia Dortmund', 'Bundesliga 1', 'Germany', today)
    results.betexplorer = { ok: !!odds, hasMarket: !!(odds && (odds.home_win || odds.over_25 || odds.btts_yes)), sample: odds }
  } catch (e) {
    results.betexplorer = { ok: false, error: e.stack || e.message }
  }

  // 4. Jina Reader
  try {
    const svc = require('../services/scrapers/JinaScraper')
    const odds = await svc.getOdds('Arsenal', 'Chelsea', 'Premier League')
    results.jina = { ok: !!odds, sample: odds ? { home_win: odds.home_win, draw: odds.draw, away_win: odds.away_win } : null }
  } catch (e) {
    results.jina = { ok: false, error: e.stack || e.message }
  }

  // 5. Free proxy pool
  try {
    const svc = require('../services/scrapers/freeProxyPool')
    results.free_proxy = { enabled: svc.isEnabled(), poolSize: svc.getStatus().poolSize, degraded: svc.getStatus().degraded }
  } catch (e) {
    results.free_proxy = { ok: false, error: e.message }
  }

  // 6. Football-Data UK (pipeline python autonome) — dry check (just import + list)
  try {
    const venvPy = path.resolve(__dirname, '..', '.venv', 'Scripts', 'python.exe')
    const out = execSync(`"${venvPy}" -c "import sys; print('py ok')"`, { encoding: 'utf8' }).trim()
    results.python_venv = { ok: out === 'py ok' }
  } catch (e) {
    results.python_venv = { ok: false, error: e.message }
  }

  // Affichage
  log('\n' + line(70))
  log('RÉSULTATS')
  log(line(70))
  for (const [k, v] of Object.entries(results)) {
    const status = v.ok === false ? '❌' : v.ok === true ? '✅' : 'ℹ️'
    log(`${status} ${k.padEnd(16)} ` + JSON.stringify(v).slice(0, 200))
  }
  log(line(70) + '\n')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
