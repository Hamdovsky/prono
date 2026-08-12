/**
 * scraperRouter.js — Automated toggle switch for scraping pipeline
 *
 * Priority chain:
 *   1. ScrapingBypass (curl_cffi TLS fingerprint spoofing — top priority)
 *   2. Firecrawl (JS execution, LLM extraction — if FIRECRAWL_API_KEY set)
 *   3. Jina Reader (static pages, zero-auth — always available)
 *   4. Python bridge (cloudscraper fallback — BetExplorer data-odd)
 *
 * Health check: auto-disable any scraper after 3 consecutive failures
 */

const path = require('path')
const fs = require('fs')

// Lazy-load scrapers
let _bypass = null
let _firecrawl = null
let _jina = null
let _pythonBridge = null

function getBypass() {
  if (!_bypass) {
    try {
      _bypass = require('./ScrapingBypassScraper')
    } catch {
      _bypass = null
    }
  }
  return _bypass
}

function getFirecrawl() {
  if (!_firecrawl) {
    try {
      _firecrawl = require('./FirecrawlScraper')
    } catch {
      _firecrawl = null
    }
  }
  return _firecrawl
}

function getJina() {
  if (!_jina) {
    try {
      _jina = require('./JinaScraper')
    } catch {
      _jina = null
    }
  }
  return _jina
}

function getPythonBridge() {
  if (!_pythonBridge) {
    try {
      const svc = require('../scrapeService')
      _pythonBridge = {
        getOdds: svc.getOdds.bind(svc),
        getLiveScores: svc.getLiveScores ? svc.getLiveScores.bind(svc) : null,
        isAvailable: () => true,
        getCacheSize: () => (svc.getCacheSize ? svc.getCacheSize() : 0),
        clearCache: svc.clearCache ? svc.clearCache.bind(svc) : () => {},
      }
    } catch {
      _pythonBridge = null
    }
  }
  return _pythonBridge
}

// ── Health tracking ────────────────────────────────────────────
const health = {
  bypass: { failures: 0, lastFailure: null, disabled: false },
  firecrawl: { failures: 0, lastFailure: null, disabled: false },
  jina: { failures: 0, lastFailure: null, disabled: false },
  python: { failures: 0, lastFailure: null, disabled: false },
}
const MAX_FAILURES = 3
const COOLDOWN_MS = 5 * 60 * 1000 // 5 min before re-trying a failed scraper

function recordFailure(name) {
  const h = health[name]
  h.failures++
  h.lastFailure = Date.now()
  if (h.failures >= MAX_FAILURES) {
    h.disabled = true
    console.warn(`[SCRAPER] ${name} disabled after ${h.failures} consecutive failures`)
    // Auto-re-enable after cooldown
    setTimeout(() => {
      h.disabled = false
      h.failures = 0
    }, COOLDOWN_MS)
  }
}

function recordSuccess(name) {
  const h = health[name]
  h.failures = 0
  h.disabled = false
}

function isHealthy(name) {
  const h = health[name]
  if (h.disabled) return false
  return true
}

// ── Mode detection ──────────────────────────────────────────────

function getMode() {
  if (process.env.FIRECRAWL_API_KEY) {
    return 'firecrawl_primary'
  }
  return 'jina_primary'
}

// ── Priority chain ──────────────────────────────────────────────

function getPriorityChain() {
  const mode = getMode()
  const chain = []

  // bypass (curl_cffi TLS fingerprint spoofing) is always top priority
  if (isHealthy('bypass')) chain.push({ name: 'bypass', scraper: getBypass(), type: 'tls_bypass' })
  if (isHealthy('firecrawl'))
    chain.push({ name: 'firecrawl', scraper: getFirecrawl(), type: 'dynamic' })
  if (isHealthy('jina')) chain.push({ name: 'jina', scraper: getJina(), type: 'static' })
  if (isHealthy('python'))
    chain.push({ name: 'python', scraper: getPythonBridge(), type: 'legacy' })

  return chain.filter((s) => s.scraper !== null && s.scraper.isAvailable())
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Get odds via the automated toggle chain.
 * Tries each scraper in priority order. Returns first successful result.
 *
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @param {string} league
 * @param {object} [opts] - { timeout, preferSource }
 * @returns {Promise<object|null>}
 */
async function getOdds(homeTeam, awayTeam, league, opts = {}) {
  const chain = getPriorityChain()
  if (chain.length === 0) {
    // Final fallback: try Python bridge directly
    const bridge = getPythonBridge()
    if (bridge) {
      try {
        const result = await bridge.getOdds(homeTeam, awayTeam, league, opts.country, opts.date)
        if (result && result.home_win) return result
      } catch {}
    }
    return null
  }

  for (const { name, scraper } of chain) {
    if (opts.preferSource && opts.preferSource !== name) continue
    try {
      const result = await scraper.getOdds(homeTeam, awayTeam, league, opts.country, opts.date)
      if (result && result.home_win) {
        recordSuccess(name)
        result._scraper = name
        result._mode = getMode()
        return result
      }
    } catch (err) {
      recordFailure(name)
      console.warn(`[SCRAPER:${name}] Failed: ${err.message}`)
    }
  }

  return null
}

/**
 * Get live scores via the toggle chain.
 */
async function getLiveScores(league) {
  const chain = getPriorityChain()

  for (const { name, scraper } of chain) {
    if (!scraper.getLiveScores) continue
    try {
      const scores = await scraper.getLiveScores(league)
      if (scores && scores.length > 0) {
        recordSuccess(name)
        return scores
      }
    } catch (err) {
      recordFailure(name)
    }
  }

  return []
}

/**
 * Get match results via Jina (Soccerway).
 */
async function getResults(league) {
  const jina = getJina()
  if (jina) {
    try {
      return await jina.getResults(league)
    } catch {}
  }
  return []
}

/**
 * Get current router status.
 */
function getStatus() {
  return {
    mode: getMode(),
    firecrawl_key_set: !!process.env.FIRECRAWL_API_KEY,
    chain: getPriorityChain().map((s) => s.name),
    health: Object.fromEntries(
      Object.entries(health).map(([k, v]) => [k, { disabled: v.disabled, failures: v.failures }])
    ),
    cache_size: {
      bypass: getBypass()?.getCacheSize?.() || 0,
      firecrawl: getFirecrawl()?.getCacheSize?.() || 0,
      jina: getJina()?.getCacheSize?.() || 0,
    },
  }
}

/**
 * Force toggle mode.
 */
function setMode(mode) {
  if (mode === 'firecrawl_primary' || mode === 'jina_primary') {
    // Create a sentinel file so mode persists across restarts
    const sentinelPath = path.join(__dirname, '..', 'data', '.scraper_mode')
    fs.writeFileSync(sentinelPath, mode, 'utf-8')
    return true
  }
  return false
}

// Load persisted mode on startup
try {
  const sentinelPath = path.join(__dirname, '..', 'data', '.scraper_mode')
  if (fs.existsSync(sentinelPath)) {
    const persisted = fs.readFileSync(sentinelPath, 'utf-8').trim()
    if (persisted === 'firecrawl_primary' || persisted === 'jina_primary') {
      // Mode is auto-detected from env, sentinel is just for persistence
    }
  }
} catch {}

module.exports = {
  getOdds,
  getLiveScores,
  getResults,
  getStatus,
  setMode,
  getMode,
  isHealthy,
  resetHealth: () => {
    Object.values(health).forEach((h) => {
      h.failures = 0
      h.disabled = false
    })
  },
}
