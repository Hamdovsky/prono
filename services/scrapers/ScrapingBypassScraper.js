const { spawn } = require('child_process')
const path = require('path')

const CACHE = new Map()
const CACHE_TTL = 10 * 60 * 1000
const BASE_DIR = path.resolve(__dirname, '..', '..')
const PYTHON_SCRIPT = path.join(BASE_DIR, 'scripts', 'bypass_scraper.py')
const isWin = process.platform === 'win32'
const VENV_PYTHON = isWin
  ? path.join(BASE_DIR, '.venv', 'Scripts', 'python.exe')
  : path.join(BASE_DIR, '.venv', 'bin', 'python3')

const BROWSER_FINGERPRINTS = ['chrome124', 'chrome120', 'chrome116', 'safari17_0', 'firefox133']

function callPython(data) {
  return new Promise((resolve, reject) => {
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
      if (code !== 0) {
        return reject(new Error(`Python exited ${code}: ${stderr.slice(0, 200)}`))
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (e) {
        reject(new Error(`Invalid JSON: ${e.message}. Raw: ${stdout.slice(0, 300)}`))
      }
    })
    proc.on('error', reject)
    proc.stdin.write(JSON.stringify(data) + '\n')
    proc.stdin.end()
  })
}

async function getOdds(homeTeam, awayTeam, league, country) {
  const cacheKey = `odds:${homeTeam}:${awayTeam}:${league}:${country || ''}`
  const cached = CACHE.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data

  for (const fp of BROWSER_FINGERPRINTS) {
    try {
      const result = await callPython({
        cmd: 'betexplorer',
        home: homeTeam,
        away: awayTeam,
        league,
        country,
        options: { fingerprint: fp, timeout: 25 },
      })
      if (result && result.odds && result.odds.home_win) {
        const out = {
          home_win: result.odds.home_win,
          draw: result.odds.draw || null,
          away_win: result.odds.away_win || null,
          _source: result.source || 'betexplorer',
          _scraper: 'bypass',
          _fingerprint: result.fingerprint || fp,
          _elapsed: result.elapsed,
        }
        CACHE.set(cacheKey, { data: out, ts: Date.now() })
        return out
      }
    } catch (err) {
      continue
    }
  }
  return null
}

async function scrapeUrl(url, opts = {}) {
  const cacheKey = `url:${url}`
  const cached = CACHE.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data

  const fingerprint = opts.fingerprint || 'chrome124'
  try {
    const result = await callPython({
      cmd: 'scrape',
      url,
      options: { fingerprint, timeout: opts.timeout || 30, proxy: opts.proxy },
    })
    if (result && !result.error) {
      CACHE.set(cacheKey, { data: result, ts: Date.now() })
      return result
    }
  } catch {}
  return null
}

function isAvailable() {
  return true
}

function getCacheSize() {
  return CACHE.size
}

function clearCache() {
  CACHE.clear()
}

module.exports = {
  getOdds,
  scrapeUrl,
  isAvailable,
  getCacheSize,
  clearCache,
}
