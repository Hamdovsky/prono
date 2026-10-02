/**
 * crawl4aiResolver.js — Resolu le venv isole .venv-crawl4ai et l'URL du service :11235
 *
 * Venv isole : requirements-crawl4ai.txt n'est reference par AUCUN Dockerfile
 * (AGENTS.md: No Chromium/Puppeteer in Docker image). Ce resolver reproduit
 * la logique de services/scrapers/SofascoreBypass.js:pickPython() pour le
 * venv crawl4ai.
 *
 * Service HTTP : scripts/crawl4ai_service.py (aiohttp :11235)
 *   GET  /health -> { status: "ok", browser_alive, version, ... }
 *   POST /md /crawl /llm-extract
 *
 * Env:
 *   CRAWL4AI_URL=http://127.0.0.1:11235 (interchangeable : local venv ou Docker unclecode/crawl4ai)
 *   CRAWL4AI_API_TOKEN= (vide = localhost sans auth)
 *   CRAWL4AI_HEALTH_TIMEOUT_MS=2000
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

let pyCache = null
let healthCache = { ts: 0, ok: false, payload: null }
const HEALTH_CACHE_TTL = 30 * 1000

function pickPython() {
  if (pyCache) return pyCache
  const candidates = [
    path.join(PROJECT_ROOT, '.venv-crawl4ai', 'Scripts', 'python.exe'),
    path.join(PROJECT_ROOT, '.venv-crawl4ai', 'bin', 'python'),
    path.join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(PROJECT_ROOT, '.venv', 'bin', 'python'),
    '/opt/venv/bin/python3',
    'python3',
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        pyCache = p
        return p
      }
    } catch (_) {}
  }
  pyCache = 'python3'
  return pyCache
}

function getCrawl4aiUrl() {
  const raw = String(process.env.CRAWL4AI_URL || 'http://127.0.0.1:11235').trim()
  return raw.replace(/\/+$/, '')
}

function isCrawl4aiEnabled() {
  const v = String(process.env.CRAWL4AI_ENABLED || 'off').toLowerCase().trim()
  return v !== 'off' && v !== '0' && v !== 'false' && v !== 'no'
}

function _getHealthUrl() {
  return getCrawl4aiUrl() + '/health'
}

function fetchHealth(timeoutMs) {
  const url = _getHealthUrl()
  const ms = Number.isFinite(timeoutMs) ? timeoutMs : parseInt(process.env.CRAWL4AI_HEALTH_TIMEOUT_MS || '2000', 10)
  return new Promise((resolve) => {
    try {
      const mod = url.startsWith('https:') ? https : http
      const parsed = new URL(url)
      const req = mod.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          timeout: ms,
        },
        (res) => {
          let data = ''
          res.on('data', (c) => (data += c))
          res.on('end', () => {
            if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode, payload: null })
            try {
              const json = JSON.parse(data)
              resolve({ ok: true, status: 200, payload: json })
            } catch (_) {
              resolve({ ok: false, status: res.statusCode, payload: null })
            }
          })
        }
      )
      req.on('error', () => resolve({ ok: false, status: 0, payload: null }))
      req.on('timeout', () => {
        req.destroy()
        resolve({ ok: false, status: 0, payload: null })
      })
      req.end()
    } catch (_) {
      resolve({ ok: false, status: 0, payload: null })
    }
  })
}

async function isAvailable(opts = {}) {
  if (!isCrawl4aiEnabled()) return false
  const now = Date.now()
  const force = !!opts.force
  if (!force && now - healthCache.ts < HEALTH_CACHE_TTL) return healthCache.ok
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : parseInt(process.env.CRAWL4AI_HEALTH_TIMEOUT_MS || '2000', 10)
  const res = await fetchHealth(timeoutMs)
  healthCache = { ts: now, ok: res.ok, payload: res.payload }
  return res.ok
}

/**
 * Lecture synchrone du cache de health, pour les appelants sync (getPriorityChain,
 * getStatus) qui ne peuvent pas await. `probed: false` = aucune sonde encore
 * realisee -> on reste optimiste et on laisse refreshHealth() trancher.
 */
function getCachedHealth() {
  const now = Date.now()
  return {
    probed: healthCache.ts > 0,
    ok: healthCache.ok,
    ageMs: healthCache.ts > 0 ? now - healthCache.ts : Infinity,
    stale: healthCache.ts === 0 || now - healthCache.ts >= HEALTH_CACHE_TTL,
    payload: healthCache.payload,
  }
}

/**
 * Sonde /health et met a jour le cache. A appeler sans await ("void
 * refreshHealth()") depuis un contexte sync pour rechauffer le cache.
 */
function refreshHealth(opts = {}) {
  return isAvailable(opts).catch(() => false)
}

async function getHealth(opts = {}) {
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : parseInt(process.env.CRAWL4AI_HEALTH_TIMEOUT_MS || '2000', 10)
  return fetchHealth(timeoutMs)
}

function clearHealthCache() {
  healthCache = { ts: 0, ok: false, payload: null }
}

function _resetForTests() {
  pyCache = null
  healthCache = { ts: 0, ok: false, payload: null }
}

/**
 * Injecte un etat de health dans le cache sans passer par le reseau.
 * Reserve aux tests offline (isAvailable() est synchrone).
 */
function _primeHealthCache(ok, payload) {
  healthCache = { ts: Date.now(), ok: !!ok, payload: payload || null }
}

module.exports = {
  pickPython,
  getCrawl4aiUrl,
  isCrawl4aiEnabled,
  isAvailable,
  getCachedHealth,
  refreshHealth,
  getHealth,
  fetchHealth,
  clearHealthCache,
  _resetForTests,
  _primeHealthCache,
  _PROJECT_ROOT: PROJECT_ROOT,
}
