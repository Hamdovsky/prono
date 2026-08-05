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
 *   export RENDER_URL=https://pronostico.onrender.com
 *   export API_SECRET_KEY=<same secret as Render>
 *   node scripts/local_fbref_scraper.js           # scrape once + push
 *   node scripts/local_fbref_scraper.js --loop    # every 12h automatically
 */

require('dotenv').config()
const axios = require('axios')
const fs = require('fs')
const logger = require('../core/logger')
const fbrefService = require('../services/fbrefService')

const API_SECRET_KEY = process.env.API_SECRET_KEY || ''
const RENDER_API_KEY = process.env.RENDER_API_KEY || '' // optional: used to auto-discover RENDER_URL
const XG_GAP_THRESHOLD = parseFloat(process.env.FBREF_XG_GAP || '0.4') // min home/away xG diff to be "pickable"
const MIN_MATCHES = parseInt(process.env.FBREF_MIN_MATCHES || '8', 10) // reliable per-team volume
const LOOP_HOURS = parseInt(process.env.FBREF_LOOP_HOURS || '12', 10)
const RATE_LIMIT_SEC = parseFloat(process.env.FBREF_RATE_LIMIT || '1.5')
const RENDER_SERVICE_NAME = process.env.RENDER_SERVICE_NAME || 'pronostico' // votre service Render (slug)

// Découvre l'URL publique du service Render via l'API Render (si RENDER_API_KEY).
// Évite de devoir éditer RENDER_URL manuellement. Timeout court au cas où.
async function discoverRenderUrl() {
  if (!RENDER_API_KEY) return ''
  try {
    const res = await axios.get('https://api.render.com/v1/services', {
      headers: { Authorization: `Bearer ${RENDER_API_KEY}` },
      timeout: 12000,
    })
    // Render API returns paginated [{ cursor, service: {...} }].
    const items = res.data || []
    const svc =
      items
        .map((it) => it.service)
        .find(
          (s) =>
            (s.name || s.slug) === RENDER_SERVICE_NAME ||
            s.serviceDetails?.url?.includes(RENDER_SERVICE_NAME)
        ) || items[0]?.service
    if (!svc) return ''
    const url = svc.serviceDetails?.url || svc.url || svc.dashboardUrl || ''
    if (url) console.log('[FBREF-SCRAPER] Discovered Render URL:', url)
    return url || ''
  } catch (e) {
    console.log('[FBREF-SCRAPER] Render discovery failed (will use RENDER_URL env):', e.message)
    return ''
  }
}

async function resolveRenderUrl() {
  if (process.env.RENDER_URL) return process.env.RENDER_URL
  return discoverRenderUrl()
}

function assertConfig(url) {
  const missing = []
  if (!url) missing.push('RENDER_URL (set directly or provide RENDER_API_KEY for auto-discovery)')
  if (!API_SECRET_KEY) missing.push('API_SECRET_KEY')
  if (missing.length) {
    console.error('[FBREF-SCRAPER] Missing: ' + missing.join(', '))
    console.error(
      'Either set RENDER_URL directly or set RENDER_API_KEY (Render API key, prefix "rnd_") to auto-discover.'
    )
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
  return {
    league: leagueCode,
    count: reliable.length,
    teams: reliable,
    bestMatches,
    scrapedAt: Date.now(),
  }
}

// Push one league batch to the Render ingestion endpoint (retry x3 on transient
// errors: 5xx, ECONNRESET, ETIMEDOUT). Non-transient (401/403/400/4xx data
// errors) fail fast so a misconfig secret is surfaced immediately.
async function pushToRender(renderUrl, leagueCode, payload, onProgress) {
  const url = `${renderUrl.replace(/\/+$/, '')}/api/fbref/xg`
  const body = { leagues: { [leagueCode]: payload } }
  const attempts = 3
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await axios.post(url, body, {
        headers: { Authorization: `Bearer ${API_SECRET_KEY}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      })
      if (attempt > 1)
        onProgress(
          `${leagueCode}: pushed ${payload.count} teams after ${attempt} attempt(s) -> HTTP ${res.status}`
        )
      else
        onProgress(
          `${leagueCode}: pushed ${payload.count} teams, ${payload.bestMatches.length} best matches -> HTTP ${res.status}`
        )
      return true
    } catch (e) {
      const status = e.response ? e.response.status : e.code
      const transient =
        !e.response || status >= 500 || status === 'ECONNRESET' || status === 'ETIMEDOUT'
      if (!transient || attempt === attempts) {
        onProgress(`${leagueCode}: PUSH FAILED (${status}) ${e.message.slice(0, 120)}`)
        return false
      }
      onProgress(`${leagueCode}: transient push error (${status}), retry ${attempt}/${attempts}...`)
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  return false
}

async function runOnce(onProgress, opts = {}) {
  const renderUrl = await resolveRenderUrl()
  assertConfig(renderUrl)
  let codes = await allLeagueCodes()
  // --league <CODE> : scraper + pousser une seule ligue (rapide, pour test/valid)
  if (opts.onlyLeague) {
    if (!fbrefService.leagues[opts.onlyLeague]) {
      onProgress(
        `[FBREF-LOCAL] Unknown league code: ${opts.onlyLeague} (available: ${codes.join(', ')})`
      )
      return
    }
    codes = [opts.onlyLeague]
  }
  let ok = 0
  let fail = 0
  onProgress(
    `[FBREF-LOCAL] Scraping ${codes.length} ligues depuis IP résidentielle (renderUrl=${renderUrl.slice(0, 40)}…)…`
  )
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
    const pushed = await pushToRender(renderUrl, code, picked, onProgress)
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
  const loop = process.argv.includes('--loop')
  const leagueIdx = process.argv.indexOf('--league')
  const onlyLeague =
    leagueIdx >= 0 && process.argv[leagueIdx + 1] ? process.argv[leagueIdx + 1].toUpperCase() : null
  const onProgress = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
  if (loop) {
    runLoop()
  } else {
    runOnce(onProgress, { onlyLeague })
      .then(() => onProgress('[FBREF-LOCAL] one-shot complete.'))
      .catch((e) => {
        console.error('[FBREF-LOCAL] fatal:', e.message)
        process.exit(1)
      })
  }
}
