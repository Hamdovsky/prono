const https = require('https')
const http = require('http')
const logger = require('../core/logger')

const SCRAPERAPI_BASE = 'http://api.scraperapi.com'
const CACHE_TTL = 10 * 60 * 1000
const cache = new Map()

function getApiKey() {
  return process.env.SCRAPERAPI_KEY || ''
}

function isAvailable() {
  return !!getApiKey()
}

function fetchViaScraperAPI(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const apiKey = getApiKey()
    if (!apiKey) return reject(new Error('SCRAPERAPI_KEY not set'))

    const params = new URLSearchParams({
      api_key: apiKey,
      url: targetUrl,
    })
    if (options.render) params.set('render', 'true')
    if (options.countryCode) params.set('country_code', options.countryCode)
    if (options.device) params.set('device', options.device)
    if (options.session) params.set('session', options.session)
    if (options.timeout) params.set('timeout', String(options.timeout))

    const proxyUrl = `${SCRAPERAPI_BASE}/?${params.toString()}`
    const parsed = new URL(proxyUrl)

    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.get(proxyUrl, {
      timeout: options.timeout || 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/html, */*',
      },
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`ScraperAPI returned ${res.statusCode}: ${data.slice(0, 200)}`))
        }
        resolve({ status: res.statusCode, data, headers: res.headers })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('ScraperAPI timeout')) })
  })
}

async function fetch(targetUrl, options = {}) {
  const cacheKey = `${options.render ? 'render:' : ''}${targetUrl}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data
  }

  const result = await fetchViaScraperAPI(targetUrl, options)
  cache.set(cacheKey, { ts: Date.now(), data: result })
  return result
}

async function fetchJSON(targetUrl, options = {}) {
  const raw = await fetch(targetUrl, { ...options, timeout: options.timeout || 30000 })
  try {
    return JSON.parse(raw.data)
  } catch (e) {
    throw new Error(`ScraperAPI JSON parse error for ${targetUrl}: ${e.message}`)
  }
}

async function fetchText(targetUrl, options = {}) {
  const raw = await fetch(targetUrl, options)
  return raw.data
}

function clearCache() {
  cache.clear()
}

function getCacheSize() {
  return cache.size
}

module.exports = {
  isAvailable,
  fetch,
  fetchJSON,
  fetchText,
  clearCache,
  getCacheSize,
}
