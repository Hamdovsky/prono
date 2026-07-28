const https = require('https')
const http = require('http')
const logger = require('../core/logger')

const BROWSERLESS_HOST = 'chrome.browserless.io'
const FUNCTION_ENDPOINT = '/function'
const SCRAPE_ENDPOINT = '/scrape'
const CONTENT_ENDPOINT = '/content'

function getToken() {
  return process.env.BROWSERLESS_TOKEN || ''
}

function isAvailable() {
  return !!getToken()
}

function buildUrl(endpoint) {
  const token = getToken()
  return `https://${BROWSERLESS_HOST}${endpoint}?token=${token}`
}

function httpRequest(url, method, body, timeout) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http
    const data = body ? JSON.stringify(body) : null

    const req = mod.request(
      url,
      {
        method: method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
        timeout: timeout || 60000,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode >= 400) {
            return reject(new Error(`Browserless returned ${res.statusCode}: ${raw.slice(0, 300)}`))
          }
          resolve({ status: res.statusCode, data: raw, headers: res.headers })
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Browserless timeout'))
    })
    if (data) req.write(data)
    req.end()
  })
}

async function runFunction(code) {
  if (!isAvailable()) {
    throw new Error('BROWSERLESS_TOKEN not set — browserless service unavailable')
  }
  const url = buildUrl(FUNCTION_ENDPOINT)

  // Wrap code in export default if not already wrapped
  const wrapped = code.trim().startsWith('export default') ? code : `export default ${code}`

  const res = await httpRequest(url, 'POST', { code: wrapped }, 90000)
  try {
    return JSON.parse(res.data)
  } catch {
    return { raw: res.data }
  }
}

async function scrape(url, options = {}) {
  if (!isAvailable()) {
    throw new Error('BROWSERLESS_TOKEN not set — browserless service unavailable')
  }
  const endpoint = buildUrl(SCRAPE_ENDPOINT)
  const body = {
    url,
    waitFor: options.waitFor || 2000,
    ...(options.waitForSelector ? { waitForSelector: options.waitForSelector } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.setExtraHeaders ? { setExtraHeaders: options.setExtraHeaders } : {}),
    ...(options.rejectResourceTypes ? { rejectResourceTypes: options.rejectResourceTypes } : {}),
    ...(options.disableJs ? { disableJs: true } : {}),
  }
  const res = await httpRequest(endpoint, 'POST', body, options.timeout || 30000)
  return res.data
}

async function screenshot(url, options = {}) {
  if (!isAvailable()) {
    throw new Error('BROWSERLESS_TOKEN not set — browserless service unavailable')
  }
  const endpoint = buildUrl('/screenshot')
  const body = {
    url,
    waitFor: options.waitFor || 2000,
    options: {
      fullPage: options.fullPage !== false,
      type: 'jpeg',
      quality: 80,
      ...(options.viewport ? { viewport: options.viewport } : {}),
    },
  }
  const res = await httpRequest(endpoint, 'POST', body, options.timeout || 30000)
  return res.data
}

module.exports = {
  isAvailable,
  runFunction,
  scrape,
  screenshot,
}
