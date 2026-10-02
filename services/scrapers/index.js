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
let _freeProxy = null
let _crawl4ai = null

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

function getFreeProxy() {
  if (!_freeProxy) {
    try {
      _freeProxy = require('./freeProxyPool')
    } catch {
      _freeProxy = null
    }
  }
  return _freeProxy
}

function getCrawl4ai() {
  if (!_crawl4ai) {
    try {
      _crawl4ai = require('./Crawl4aiScraper')
    } catch {
      _crawl4ai = null
    }
  }
  return _crawl4ai
}

// ── Health tracking ────────────────────────────────────────────
const health = {
  bypass: { failures: 0, lastFailure: null, disabled: false },
  firecrawl: { failures: 0, lastFailure: null, disabled: false },
  jina: { failures: 0, lastFailure: null, disabled: false },
  python: { failures: 0, lastFailure: null, disabled: false },
  free_proxy: { failures: 0, lastFailure: null, disabled: false },
  crawl4ai: { failures: 0, lastFailure: null, disabled: false },
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
  // Env wins over the persisted sentinel (dashboard toggle).
  if (process.env.FIRECRAWL_API_KEY) {
    return 'firecrawl_primary'
  }
  // Sentinel written by setMode() — re-read on startup/restart so the toggle
  // actually persists across processes.
  const sentinelPath = path.join(__dirname, '..', 'data', '.scraper_mode')
  try {
    if (fs.existsSync(sentinelPath)) {
      const persisted = fs.readFileSync(sentinelPath, 'utf-8').trim()
      if (persisted === 'firecrawl_primary' || persisted === 'jina_primary') {
        return persisted
      }
    }
  } catch (_) {}
  return 'jina_primary'
}

/**
 * Rechauffe le cache /health de Crawl4AI sans bloquer l'appelant sync.
 * Le .catch est indispensable : une promesse rejetee non consommee
 * declenche un unhandledRejection qui tue le process Node.
 */
function refreshCrawl4aiHealth(c4a) {
  try {
    const p = c4a && c4a.refreshHealth ? c4a.refreshHealth() : null
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch (_) {}
}

// ── Priority chain ──────────────────────────────────────────────

function getPriorityChain() {
  const mode = getMode()
  const chain = []

  // bypass (curl_cffi TLS fingerprint spoofing) is always top priority
  if (isHealthy('bypass')) chain.push({ name: 'bypass', scraper: getBypass(), type: 'tls_bypass' })
  // Crawl4AI browser (www.sofascore.com JS-lourd) — only when enabled + healthy, before Firecrawl/Jina
  if (isHealthy('crawl4ai')) {
    const c4a = getCrawl4ai()
    if (c4a && c4a.isAvailable()) {
      // getPriorityChain est sync : on rechauffe le cache /health en arriere-plan
      // pour que le prochain appel (et getStatus) reflete l'etat reel du service.
      refreshCrawl4aiHealth(c4a)
      chain.push({ name: 'crawl4ai', scraper: c4a, type: 'browser' })
    }
  }
  if (isHealthy('firecrawl'))
    chain.push({ name: 'firecrawl', scraper: getFirecrawl(), type: 'dynamic' })
  if (isHealthy('jina')) chain.push({ name: 'jina', scraper: getJina(), type: 'static' })
  if (isHealthy('python'))
    chain.push({ name: 'python', scraper: getPythonBridge(), type: 'legacy' })

  return chain.filter((s) => s.scraper !== null && s.scraper.isAvailable())
}

// ── Public API ──────────────────────────────────────────────────

// Un résultat est exploitable s'il porte au moins un marché réel (1X2 OU O/U OU BTTS).
function hasAnyMarket(result) {
  if (!result) return false
  return Boolean(
    (result.home_win && result.away_win) ||
      result.over_25 ||
      result.under_25 ||
      result.btts_yes ||
      result.btts_no ||
      result.over25 ||
      result.under25
  )
}

// ── Palier "free_proxy" (primaire quand activé & sain) ──────────
// Réutilise le TLS-bypass à travers une IP libre du pool (monosans/proxy-list),
// pour économiser les paliers payants. Auto-dégradation : si le taux de succès
// du pool passe sous 25 %, le routeur rend la priorité aux scrapers payants.
function tryFreeProxyOdds(homeTeam, awayTeam, league, country, date) {
  const pool = getFreeProxy()
  const bypass = getBypass()
  if (!pool || !bypass || !pool.isEnabled() || pool.isDegraded()) return null
  return (async () => {
    for (let i = 0; i < 3; i++) {
      const proxy = pool.getProxy()
      if (!proxy) break
      try {
        const result = await bypass.getOdds(homeTeam, awayTeam, league, country, date, pool.getProxyUrl(proxy))
        if (result && hasAnyMarket(result)) {
          pool.recordAttempt(true)
          result._scraper = 'free_proxy'
          result._mode = getMode()
          return result
        }
        pool.recordAttempt(false)
      } catch (err) {
        pool.recordAttempt(false)
        pool.markBad(proxy)
      }
    }
    return null
  })()
}

/**
 * Get odds via the automated toggle chain.
 * Tries each scraper in priority order. Returns first successful result.
 *
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @param {string} league
 * @param {object} [opts] - { timeout, preferSource, skipFreeProxy }
 * @returns {Promise<object|null>}
 */
async function getOdds(homeTeam, awayTeam, league, opts = {}) {
  // Palier free-proxy en premier (source principale quand activé & sain).
  if (!opts.skipFreeProxy && !opts.preferSource) {
    const viaProxy = await tryFreeProxyOdds(homeTeam, awayTeam, league, opts.country, opts.date)
    if (viaProxy) return viaProxy
  }

  const chain = getPriorityChain()
  if (chain.length === 0) {
    // Final fallback: try Python bridge directly
    const bridge = getPythonBridge()
    if (bridge) {
      try {
        const result = await bridge.getOdds(homeTeam, awayTeam, league, opts.country, opts.date)
        if (hasAnyMarket(result)) return result
      } catch {}
    }
    return null
  }

  for (const { name, scraper } of chain) {
    if (opts.preferSource && opts.preferSource !== name) continue
try {
        const result = await scraper.getOdds(homeTeam, awayTeam, league, opts.country, opts.date)
        if (result && hasAnyMarket(result)) {
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
 * Get match results via Crawl4AI then Jina.
 */
async function getResults(league) {
  const c4a = getCrawl4ai()
  if (c4a && c4a.isAvailable() && c4a.getResults) {
    try {
      const res = await c4a.getResults(league)
      if (res && res.length > 0) return res
    } catch (_) {}
  }
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
  const pool = getFreeProxy()
  let crawl4aiInfo = null
  try {
    const resolver = require('../../core/utils/crawl4aiResolver')
    const c4a = getCrawl4ai()
    const healthCache = resolver.getCachedHealth()
    refreshCrawl4aiHealth(c4a)
    crawl4aiInfo = {
      enabled: resolver.isCrawl4aiEnabled(),
      url: resolver.getCrawl4aiUrl(),
      available: !!(c4a && c4a.isAvailable()),
      health_probed: healthCache.probed,
      health_age_ms: healthCache.probed ? healthCache.ageMs : null,
      cache_size: c4a ? c4a.getCacheSize() : 0,
      health: health.crawl4ai,
    }
  } catch (_) {
    crawl4aiInfo = { enabled: false, url: null, available: false, cache_size: 0, health: health.crawl4ai }
  }
  return {
    mode: getMode(),
    firecrawl_key_set: !!process.env.FIRECRAWL_API_KEY,
    free_proxy_enabled: !!(pool && pool.isEnabled()),
    chain: getPriorityChain().map((s) => s.name),
    health: Object.fromEntries(
      Object.entries(health).map(([k, v]) => [k, { disabled: v.disabled, failures: v.failures }])
    ),
    free_proxy: pool ? pool.getStatus() : null,
    crawl4ai: crawl4aiInfo,
    cache_size: {
      bypass: getBypass()?.getCacheSize?.() || 0,
      firecrawl: getFirecrawl()?.getCacheSize?.() || 0,
      jina: getJina()?.getCacheSize?.() || 0,
      crawl4ai: getCrawl4ai()?.getCacheSize?.() || 0,
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

module.exports = {
  getOdds,
  getLiveScores,
  getResults,
  getStatus,
  setMode,
  getMode,
  isHealthy,
  getCrawl4ai,
  resetHealth: () => {
    Object.values(health).forEach((h) => {
      h.failures = 0
      h.disabled = false
    })
  },
}
