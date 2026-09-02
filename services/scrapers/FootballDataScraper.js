/**
 * FootballDataScraper — Scrapes CSV odds from football-data.co.uk
 *
 * Optimisé pour 8GB RAM + réseau non surchargé:
 * - Lazy scraping: skip HTTP si cache valide
 * - Prune auto: supprime données > 7 jours
 * - Cache compression gzip
 *
 * Stability: retry exponential backoff, cache borné, timeout
 */
const https = require('https')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const BASE_DIR = path.resolve(__dirname, '..', '..')
const CACHE_DIR = path.join(BASE_DIR, 'data', 'football_data')
const CACHE_TTL = 6 * 60 * 60 * 1000
const MAX_CACHE = 30
const MAX_RETRIES = 3
const RETRY_BASE_DELAY = 1000
const REQUEST_TIMEOUT = 10000
const PRUNE_DAYS = 7

const LEAGUE_CODES = {
  E0: 'england/premier-league',
  E1: 'england/championship',
  E2: 'england/league-one',
  D1: 'germany/bundesliga',
  I1: 'italy/serie-a',
  SP1: 'spain/la-liga',
  F1: 'france/ligue-1',
  N1: 'netherlands/eredivisie',
  P1: 'portugal/primeira-liga',
  B1: 'brazil/serie-a',
}

const CSV_URLS = {
  E0: 'https://www.football-data.co.uk/mmz4281/2627/E0.csv',
  E1: 'https://www.football-data.co.uk/mmz4281/2627/E1.csv',
  E2: 'https://www.football-data.co.uk/mmz4281/2627/E2.csv',
  D1: 'https://www.football-data.co.uk/mmz4281/2627/D1.csv',
  I1: 'https://www.football-data.co.uk/mmz4281/2627/I1.csv',
  SP1: 'https://www.football-data.co.uk/mmz4281/2627/SP1.csv',
  F1: 'https://www.football-data.co.uk/mmz4281/2627/F1.csv',
  N1: 'https://www.football-data.co.uk/mmz4281/2627/N1.csv',
  P1: 'https://www.football-data.co.uk/mmz4281/2627/P1.csv',
  B1: 'https://www.football-data.co.uk/mmz4281/2627/B1.csv',
}

// ─── Compressed Cache ───────────────────────────────────────────────────────────
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
    console.warn(`[FootballData] Cache compress error: ${e.message}`)
  }
}

function ensureCacheDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
    }
  } catch (err) {
    console.error(`[FootballData] Cannot create cache dir: ${err.message}`)
  }
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map((h) => h.trim())
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',')
    if (values.length < headers.length) continue
    const row = {}
    headers.forEach((h, idx) => {
      row[h.trim()] = values[idx] ? values[idx].trim() : ''
    })
    rows.push(row)
  }
  return rows
}

function fetchCsvWithRetry(url, leagueCode) {
  return new Promise((resolve, reject) => {
    let attempt = 0

    const tryFetch = () => {
      const req = https.get(
        url,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: REQUEST_TIMEOUT },
        (res) => {
          if (res.statusCode !== 200) {
            attempt++
            if (attempt <= MAX_RETRIES) {
              const delay = RETRY_BASE_DELAY * Math.pow(2, attempt)
              console.warn(`[FootballData] Retry ${attempt}/${MAX_RETRIES} for ${leagueCode} in ${delay}ms`)
              setTimeout(() => req.destroy(), 100)
              setTimeout(tryFetch, delay)
            } else {
              reject(new Error(`HTTP ${res.statusCode} after ${MAX_RETRIES} attempts`))
            }
            return
          }

          let data = ''
          res.on('data', (c) => (data += c))
          res.on('end', () => {
            try {
              const parsed = parseCsv(data)
              cacheSet(leagueCode, parsed)
              ensureCacheDir()
              const cacheFile = path.join(CACHE_DIR, `${leagueCode}.json`)
              fs.writeFileSync(cacheFile, JSON.stringify(parsed), 'utf8')
              resolve(parsed)
            } catch (e) {
              reject(e)
            }
          })
        }
      )

      req.on('error', (err) => {
        attempt++
        if (attempt <= MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY * Math.pow(2, attempt)
          console.warn(`[FootballData] Retry ${attempt}/${MAX_RETRIES} for ${leagueCode} in ${delay}ms`)
          setTimeout(tryFetch, delay)
        } else {
          reject(err)
        }
      })

      req.on('timeout', () => {
        req.destroy()
        attempt++
        if (attempt <= MAX_RETRIES) {
          setTimeout(tryFetch, RETRY_BASE_DELAY * Math.pow(2, attempt))
        } else {
          reject(new Error('Timeout'))
        }
      })
    }

    tryFetch()
  })
}

async function getOddsForLeague(leagueCode, forceRefresh = false) {
  const url = CSV_URLS[leagueCode]
  if (!url) return []

  if (!forceRefresh) {
    const cached = cacheGet(leagueCode)
    if (cached) {
      console.log(`[FootballData] Cache HIT for ${leagueCode} (${cached.length} rows)`)
      return cached
    }
  }

  try {
    console.log(`[FootballData] Cache MISS — fetching ${leagueCode} from network`)
    return await fetchCsvWithRetry(url, leagueCode)
  } catch (e) {
    console.error(`[FootballData] Failed to fetch ${leagueCode}: ${e.message}`)
    return []
  }
}

async function getOddsForMatch(homeTeam, awayTeam, leagueCode) {
  try {
    const rows = await getOddsForLeague(leagueCode)
    if (!rows || rows.length === 0) return null

    const homeL = homeTeam.toLowerCase()
    const awayL = awayTeam.toLowerCase()

    const match = rows.find((r) => {
      const rHome = (r.HomeTeam || '').toLowerCase()
      const rAway = (r.AwayTeam || '').toLowerCase()
      return (
        rHome.includes(homeL) || homeL.includes(rHome)
      ) && (
        rAway.includes(awayL) || awayL.includes(rAway)
      )
    })

    if (!match) return null

    return {
      home: parseFloat(match.AvgH) || null,
      draw: parseFloat(match.AvgD) || null,
      away: parseFloat(match.AvgA) || null,
      over25: parseFloat(match['Avg>2.5']) || null,
      under25: parseFloat(match['Avg<2.5']) || null,
      source: 'football-data.co.uk',
    }
  } catch (e) {
    console.error(`[FootballData] getOddsForMatch error: ${e.message}`)
    return null
  }
}

function pruneOldCacheFiles() {
  const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000
  let pruned = 0

  try {
    if (!fs.existsSync(CACHE_DIR)) return 0
    const files = fs.readdirSync(CACHE_DIR)

    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const filePath = path.join(CACHE_DIR, file)
      const stat = fs.statSync(filePath)
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath)
        pruned++
        console.log(`[FootballData] Pruned old file: ${file}`)
      }
    }
  } catch (err) {
    console.warn(`[FootballData] Prune error: ${err.message}`)
  }

  return pruned
}

function getLeagueName(code) {
  const names = {
    E0: 'Premier League',
    E1: 'Championship',
    E2: 'League One',
    D1: 'Bundesliga',
    I1: 'Serie A',
    SP1: 'La Liga',
    F1: 'Ligue 1',
    N1: 'Eredivisie',
    P1: 'Primeira Liga',
    B1: 'Serie A Brasil',
  }
  return names[code] || code
}

function getCacheStats() {
  return {
    size: cache.size,
    max: MAX_CACHE,
    ttlHours: CACHE_TTL / 3600000,
  }
}

function logHealth() {
  const mem = process.memoryUsage()
  const stats = getCacheStats()
  console.log(`[HEALTH] FootballData | RSS: ${Math.round(mem.rss / 1024 / 1024)}MB | Cache: ${stats.size}/${stats.max}`)
  return {
    rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
    cache: stats,
  }
}

function clearCache() {
  cache.clear()
}

module.exports = {
  getOddsForLeague,
  getOddsForMatch,
  getLeagueName,
  getCacheStats,
  logHealth,
  pruneOldCacheFiles,
  clearCache,
  LEAGUE_CODES,
  CSV_URLS,
}
