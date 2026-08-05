/**
 * Local fbref scraper (run from a RESIDENTIAL IP — e.g. your home machine).
 *
 * Why: fbref.com is Cloudflare-blocked from Render datacenter IPs, but is fine
 * from residential IPs (~1 page / 1.5s tolerated). This script scrapes per-team
 * expected goals for EVERY league fbref covers, KEEPS ONLY the teams/matches
 * that constitute "easy to predict" matchups (clear xG favorite, enough games
 * for reliability), and PUSHES a compact payload to the Render server, which
 * writes data/fbref_team_xg.json.
 *
 * On Render, fbrefService._loadPushedFile() reads that file with priority, so
 * the Poisson engine gets REAL fbref xG for the favored matchups instead of
 * the uniform ~35/33/32 fallback.
 *
 * Run locally:
 *   export RENDER_URL=https://prono-api-<>.onrender.com
 *   export API_SECRET_KEY=<same secret as Render>
 *   node scripts/local_fbref_scraper.js           # scrape once + push
 *   node scripts/local_fbref_scraper.js --loop    # every 12h automatically
 */

require('dotenv').config()
const axios = require('axios')
const fs = require('fs')
const logger = require('../core/logger')
const fbrefService = require('../services/fbrefService')

const RENDER_URL = process.env.RENDER_URL || ''
const API_SECRET_KEY = process.env.API_SECRET_KEY || ''
const XG_GAP_THRESHOLD = parseFloat(process.env.FBREF_XG_GAP || '0.4') // min home/away xG diff to be "pickable"
const MIN_MATCHES = parseInt(process.env.FBREF_MIN_MATCHES || '8', 10) // reliable per-team volume
const LOOP_HOURS = parseInt(process.env.FBREF_LOOP_HOURS || '12', 10)
const RATE_LIMIT_SEC = parseFloat(process.env.FBREF_RATE_LIMIT || '1.5')

function assertConfig() {
  const missing = []
  if (!RENDER_URL) missing.push('RENDER_URL')
  if (!API_SECRET_KEY) missing.push('API_SECRET_KEY')
  if (missing.length) {
    console.error('[FBREF-SCRAPER] Missing: ' + missing.join(', '))
    console.error('Set RENDER_URL (= https://prono-api-<>.onrender.com) and API_SECRET_KEY (same secret on Render).')
    process.exit(2)
  }
}

// Sleep helper (rate limit fbref tolerates)
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000))

// All leagues fbref covers that we attempt (leagueCode -> human label).
// Only the ones present in fbrefService.leagues are scrapable.
async function allLeagueCodes() {
  return Object.keys(fbrefService.leagues)
}

// For one league, return the full scraped team table.
async function scrapeLeague(code, onProgress) {
  await sleep(RATE_LIMIT_SEC) // polite to fbref
  try {
    const stats = await fbrefService.getTeamStats(code)
    return stats || []
  } catch (e) {
    logger.warn(`[FBREF-LOCAL] scrape ${code} failed: ${e.message}`)
    return []
  }
}

// Keep only the "pickable" teams: enough matches played & clear xG signal.
// Returns {league, teams:[...], bestMatches:[{home,away,xgGap}...]}.
function pickBest(leagueCode, teams) {
  const reliable = (teams || []).filter(
    (t) =>
      t &&
      t.matches >= MIN_MATCHES &&
      (t.xG != null || t.xGA != null) &&
      // reject "stale fragment" tables with one tiny season
      t.matches > 2
  )
  // bestMatches = pairs of teams with a clear xG gap (>= threshold) — the
  // "easy to predict" matchups where the Poisson will be differentiated.
  const bestMatches = []
  const sorted = reliable.slice().sort((a, b) => (b.xG || 0) - (a.xG || 0))
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && bestMatches.length < 6; j++) {
      const h = sorted[i]
      const a = sorted[j]
      const gap = Math.abs((h.xG || 0) - (a.xG || 0))
      if (gap >= XG_GAP_THRESHOLD) {
        bestMatches.push({ home: h.team, away: a.team, xgHome: h.xG, xgAway: a.xG, xgGap: gap })
      }
    }
  }
  return { league: leagueCode, count: reliable.length, teams: reliable, bestMatches }
}

// Push one league batch to the Render ingestion endpoint.
async function pushToRender(leagueCode, payload, onProgress) {
  const body = { leagues: { [leagueCode]: payload } }
  try {
    const res = await axios.post(`${RENDER_URL.replace(/\/+$/, '')}/api/fbref/xg`, body, {
      headers: { 'x-api-key': API_SECRET_KEY, 'Content-Type': 'application/json' },
      timeout: 30000,
    })
    onProgress(`${leagueCode}: pushed ${payload.count} teams, ${payload.bestMatches.length} best matches -> HTTP ${res.status}`)
    return true
  } catch (e) {
    const status = e.response ? e.response.status : e.code
    onProgress(`${leagueCode}: PUSH FAILED (${status}) ${e.message.slice(0, 120)}`)
    return false
  }
}

async function runOnce(onProgress) {
  const codes = await allLeagueCodes()
  let ok = 0
  let fail = 0
  onProgress(`[FBREF-LOCAL] Scraping ${codes.length} ligues depuis IP résidentielle...`)
  for (const code of codes) {
    const teams = await scrapeLeague(code, onProgress)
    if (!teams.length) {
      onProgress(`${code}: no data`)
      fail++
      continue
    }
    const picked = pickBest(code, teams)
    if (!picked.count) {
      onProgress(`${code}: ${teams.length} teams but none meets min matches (${MIN_MATCHES})`)
      fail++
      continue
    }
    const pushed = await pushToRender(code, picked, onProgress)
    pushed ? ok++ : fail++
    // fbref is rate-limited (~1.5s already inside scrapeLeague); no extra wait
  }
  onProgress(`[FBREF-LOCAL] Done. ${ok} pushed, ${fail} skipped.`)
}

function runLoop() {
  const intervalMs = LOOP_HOURS * 60 * 60 * 1000
  runOnce(console.log).catch((e) => console.error('[FBREF-LOCAL] loop error:', e.message))
  setInterval(() => runOnce(console.log).catch(() => {}), intervalMs)
  console.log(`[FBREF-LOCAL] Looping every ${LOOP_HOURS}h. Ctrl+C to stop.`)
}

if (require.main === module) {
  assertConfig()
  const loop = process.argv.includes('--loop')
  const onProgress = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
  if (loop) {
    runLoop()
  } else {
    runOnce(onProgress).catch((e) => {
      console.error('[FBREF-LOCAL] fatal:', e.message)
      process.exit(1)
    })
  }
}
