/**
 * ScrapingBypassScraper — Scrape BetExplorer via Python curl_cffi.
 *
 * Optimisé pour 8GB RAM + réseau non surchargé:
 * - Cache compression gzip (mémoire réduite ~60%)
 * - Circuit breaker (15 failures → pause 30s)
 * - Cache LRU borné (100 entrées)
 * - Retry exponential backoff
 *
 * Usage:
 *   const be = require('./ScrapingBypassScraper')
 *   const odds = await be.getOdds('Arsenal', 'Liverpool', 'Premier League')
 */
const { spawn } = require('child_process')
const path = require('path')
const zlib = require('zlib')

const MAX_CACHE = 100
const CACHE_TTL = 10 * 60 * 1000
const MAX_RETRIES = 2
const RETRY_BASE_DELAY = 2000
const PROCESS_TIMEOUT = 30000
const CIRCUIT_BREAKER_THRESHOLD = 100
const CIRCUIT_BREAKER_TIMEOUT = 30000

const BASE_DIR = path.resolve(__dirname, '..', '..')
const PYTHON_SCRIPT = path.join(BASE_DIR, 'scripts', 'bypass_scraper.py')
const isWin = process.platform === 'win32'
const VENV_PYTHON = isWin
  ? path.join(BASE_DIR, '.venv', 'Scripts', 'python.exe')
  : path.join(BASE_DIR, '.venv', 'bin', 'python3')

const BROWSER_FINGERPRINTS = ['chrome124', 'chrome120', 'chrome116', 'safari17_0', 'firefox133']

// ─── Circuit Breaker ───────────────────────────────────────────────────────────
let circuitState = { failures: 0, lastFailure: 0, state: 'CLOSED' }

function isCircuitOpen() {
  if (circuitState.state === 'CLOSED') return false
  if (circuitState.state === 'HALF_OPEN') return false
  if (Date.now() - circuitState.lastFailure > CIRCUIT_BREAKER_TIMEOUT) {
    circuitState.state = 'HALF_OPEN'
    console.warn('[ScrapingBypass] Circuit breaker HALF-OPEN')
    return false
  }
  return true
}

function recordFailure() {
  circuitState.failures++
  circuitState.lastFailure = Date.now()
  if (circuitState.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitState.state = 'OPEN'
    console.error(`[ScrapingBypass] Circuit OPEN after ${circuitState.failures} failures`)
  }
}

function recordSuccess() {
  if (circuitState.state === 'HALF_OPEN') {
    console.warn('[ScrapingBypass] Circuit CLOSED')
  }
  circuitState.failures = 0
  circuitState.state = 'CLOSED'
}

// ─── Compressed Cache ──────────────────────────────────────────────────────────
const cache = new Map()

function cacheGet(key) {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key)
    return null
  }
  cache.delete(key)
  cache.set(key, entry)
  try {
    const decompressed = zlib.gunzipSync(entry.data)
    return JSON.parse(decompressed.toString('utf8'))
  } catch (e) {
    cache.delete(key)
    return null
  }
}

function cacheSet(key, data) {
  if (cache.size >= MAX_CACHE) {
    const firstKey = cache.keys().next().value
    if (firstKey !== undefined) cache.delete(firstKey)
  }
  try {
    const compressed = zlib.gzipSync(JSON.stringify(data))
    cache.set(key, { data: compressed, ts: Date.now() })
  } catch (e) {
    console.warn(`[ScrapingBypass] Cache compress error: ${e.message}`)
  }
}

// ─── Python Call with Timeout ─────────────────────────────────────────────────
function callPython(data, timeoutMs = PROCESS_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        proc.kill()
        reject(new Error(`Python timeout after ${timeoutMs}ms`))
      }
    }, timeoutMs)

    const proc = spawn(VENV_PYTHON, [PYTHON_SCRIPT], {
      cwd: BASE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk) => (stdout += chunk))
    proc.stderr.on('data', (chunk) => (stderr += chunk))

    proc.on('close', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        if (code !== 0) {
          reject(new Error(`Python exited ${code}: ${stderr.slice(0, 200)}`))
        } else {
          try {
            resolve(JSON.parse(stdout))
          } catch (e) {
            reject(new Error(`Invalid JSON: ${e.message}`))
          }
        }
      }
    })

    proc.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(err)
      }
    })

    proc.stdin.write(JSON.stringify(data) + '\n')
    proc.stdin.end()
  })
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────
async function withRetry(fn, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const isLast = attempt >= retries
      const isWorthRetrying = err.message.includes('timeout') || err.message.includes('ECONN')

      if (isLast || !isWorthRetrying) throw err

      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt)
      console.warn(`[ScrapingBypass] Retry ${attempt + 1}/${retries} in ${delay}ms`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
}

// ─── Main API ────────────────────────────────────────────────────────────────
async function getOdds(homeTeam, awayTeam, league, country, date, proxy) {
  if (isCircuitOpen()) {
    console.warn('[ScrapingBypass] Circuit OPEN — skipping')
    return null
  }

  const cacheKey = `odds:${homeTeam}:${awayTeam}:${league}:${country || ''}:${date || ''}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  for (const fp of BROWSER_FINGERPRINTS) {
    try {
      const result = await withRetry(() =>
        callPython({
          cmd: 'betexplorer',
          home: homeTeam,
          away: awayTeam,
          league,
          country,
          date,
          options: { fingerprint: fp, timeout: 25, proxy },
        })
      )

      if (result && result.odds && result.odds.home_win) {
        const out = {
          home_win: result.odds.home_win,
          draw: result.odds.draw || null,
          away_win: result.odds.away_win || null,
          over_25: result.over_25 || null,
          under_25: result.under_25 || null,
          btts_yes: result.btts_yes || null,
          btts_no: result.btts_no || null,
          _source: result.source || 'betexplorer',
          _scraper: 'bypass',
          _fingerprint: result.fingerprint || fp,
          _elapsed: result.elapsed,
        }
        cacheSet(cacheKey, out)
        recordSuccess()
        return out
      }
    } catch (err) {
      console.warn(`[ScrapingBypass] ${fp} failed: ${err.message}`)
    }
  }

  recordFailure()
  return null
}

async function getOdds1x2(homeTeam, awayTeam, league, country, date, proxy) {
  if (isCircuitOpen()) return null

  const cacheKey = `odds1x2:${homeTeam}:${awayTeam}:${league}:${country || ''}:${date || ''}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  try {
    const result = await withRetry(() =>
      callPython({
        cmd: 'betexplorer_1x2',
        home: homeTeam,
        away: awayTeam,
        league,
        country,
        date,
        options: { fingerprint: BROWSER_FINGERPRINTS[0], timeout: 25, proxy },
      })
    )

    if (result && result.odds && result.odds.home_win) {
      const out = {
        home_win: result.odds.home_win,
        draw: result.odds.draw || null,
        away_win: result.odds.away_win || null,
        _source: result.source || 'betexplorer',
        _scraper: 'bypass',
      }
      cacheSet(cacheKey, out)
      recordSuccess()
      return out
    }
  } catch (err) {
    console.warn(`[ScrapingBypass] getOdds1x2 failed: ${err.message}`)
  }

  recordFailure()
  return null
}

async function scrapeUrl(url, opts = {}) {
  if (isCircuitOpen()) return null

  const cacheKey = `url:${url}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  try {
    const result = await withRetry(() =>
      callPython({
        cmd: 'scrape',
        url,
        options: { fingerprint: opts.fingerprint || 'chrome124', timeout: opts.timeout || 30, proxy: opts.proxy },
      })
    )

    if (result && !result.error) {
      cacheSet(cacheKey, result)
      recordSuccess()
      return result
    }
  } catch (err) {
    console.warn(`[ScrapingBypass] scrapeUrl failed: ${err.message}`)
  }

  recordFailure()
  return null
}

function isAvailable() {
  return !isCircuitOpen()
}

function getCacheStats() {
  return {
    size: cache.size,
    max: MAX_CACHE,
    circuitState: circuitState.state,
    failures: circuitState.failures,
  }
}

function logHealth() {
  const mem = process.memoryUsage()
  const stats = getCacheStats()
  console.log(`[HEALTH] ScrapingBypass | RSS: ${Math.round(mem.rss / 1024 / 1024)}MB | Cache: ${stats.size}/${stats.max} | Circuit: ${stats.circuitState}`)
  return {
    rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
    cache: stats,
  }
}

function clearCache() {
  cache.clear()
}

function resetCircuitBreaker() {
  circuitState = { failures: 0, lastFailure: 0, state: 'CLOSED' }
}

module.exports = {
  getOdds,
  getOdds1x2,
  scrapeUrl,
  isAvailable,
  getCacheStats,
  clearCache,
  resetCircuitBreaker,
  logHealth,
}
