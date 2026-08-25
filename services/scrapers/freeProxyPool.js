/**
 * freeProxyPool.js — Pool de proxys libres (monosans/proxy-list) pour le scraping.
 *
 * Rôle : source de proxies HTTP gratuits, re-vérifiés, avec rotation, blacklist
 * temporaire et suivi de qualité. Utilisé par le routeur de scrapers comme palier
 * "free_proxy" (prioritaire quand FREE_PROXY_ENABLED=1 et pool sain) afin de
 * réduire la consommation des services payants (Firecrawl / ScraperAPI).
 *
 * Règles de sécurité (non négociables) :
 *   - HTTPS uniquement ; aucun credential envoyé à un proxy ;
 *   - allowlist de domains publics de cotes (FREE_PROXY_ALLOWLIST sinon défaut) ;
 *   - refus des URLs contenant api_key/secret/token/password ;
 *   - pool vide ou désactivé -> retourne null sans jamais casser la chaîne.
 *
 * Qualité / auto-dégradation : chaque essai est tracé (fenêtre glissante). Si le
 * taux de succès passe sous 25 % sur 40 essais, le palier est considéré dégradé
 * et le routeur lui rend la priorité aux scrapers payants jusqu'à récupération.
 *
 * Le socle réseau est un tunnel CONNECT en Node pur (aucune dépendance) :
 * les listes ne sont fetchées que si FREE_PROXY_ENABLED=1.
 */

const net = require('net')
const tls = require('tls')
const https = require('https')

// ── Constantes ─────────────────────────────────────────────────
const LIST_URLS = [
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
]
const REFRESH_MS = 30 * 60 * 1000
const FETCH_TIMEOUT_MS = 10 * 1000
const HEALTH_TIMEOUT_MS = 3000
const REQUEST_TIMEOUT_MS = 12000
const MAX_POOL = 15
const HEALTH_CANDIDATES = 30
const HEALTH_PARALLEL = 6
const MAX_ATTEMPTS = 4
const BAN_TTL_MS = 15 * 60 * 1000
const MAX_PER_PROXY = 2
const QUALITY_WINDOW = 40
const DEGRADE_RATE = 0.25

const DEFAULT_ALLOWLIST = [
  'betexplorer.com',
  'soccerway.com',
  'flashscore.com',
  'flashscore.bet',
  'sofascore.com',
  'fbref.com',
  'understat.com',
  'understat.org',
  'football-data.co.uk',
  'footystats.org',
  'promosport.tn',
  'tunisiasport.tn',
  'sportytrader.com',
  'windrawwin.com',
  'forebet.com',
]

// ── État process-wide (mémoire, non persistant) ────────────────
const state = {
  enabled: process.env.FREE_PROXY_ENABLED === '1',
  pool: [], // [ 'host:port', ... ]
  badUntil: new Map(), // proxy -> timestamp de fin de ban
  inFlight: new Map(), // proxy -> compteur d'usages simultanés
  cursor: 0,
  lastRefresh: 0,
  refreshing: false,
  attempts: [], // fenêtre glissante { ok, ts }
}

// ── Helpers publics / purs (testables) ─────────────────────────

/** Extrait les lignes host:port (ignore commentaires, creds, protocole). */
function parseProxyList(text) {
  const out = []
  const seen = new Set()
  for (const raw of (text || '').split(/\r?\n/)) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.includes('://')) line = line.split('://', 2)[1]
    if (line.includes('@')) line = line.split('@').pop()
    if (line.includes('/')) continue
    const host = line.slice(0, line.lastIndexOf(':'))
    const port = line.slice(line.lastIndexOf(':') + 1)
    if (!host || !port || !/^\d{1,5}$/.test(port)) continue
    const p = Number(port)
    if (!(p > 0 && p <= 65535)) continue
    if (/[^A-Za-z0-9.\-]/.test(host)) continue
    const key = `${host}:${port}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

/** Garde : HTTPS + domain en allowlist + pas de paramètre sensible. */
function isAllowedUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false
  let u
  try {
    u = new URL(rawUrl)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  const allowlist = process.env.FREE_PROXY_ALLOWLIST
    ? process.env.FREE_PROXY_ALLOWLIST.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ALLOWLIST
  const host = u.hostname.toLowerCase()
  const okDomain = allowlist.some((d) => host === d || host.endsWith('.' + d))
  if (!okDomain) return false
  return !/(api[_-]?key|secret|token|passwd|password)=/i.test(u.search)
}

function getQuality() {
  const w = state.attempts.slice(-QUALITY_WINDOW)
  if (w.length < 5) return null
  return w.filter((a) => a.ok).length / w.length
}

function isDegraded() {
  const q = getQuality()
  return q !== null && q < DEGRADE_RATE
}

function recordAttempt(ok) {
  state.attempts.push({ ok: !!ok, ts: Date.now() })
  if (state.attempts.length > QUALITY_WINDOW) state.attempts.shift()
}

function markBad(proxy) {
  if (proxy) state.badUntil.set(proxy, Date.now() + BAN_TTL_MS)
}

/** Prochain proxy (host:port) non banni, round-robin, avec cap de concurrence. */
function getProxy() {
  if (!state.enabled) return null
  if (state.pool.length === 0 || Date.now() - state.lastRefresh > REFRESH_MS) {
    refreshPool().catch(() => {})
  }
  if (state.pool.length === 0) return null
  const now = Date.now()
  for (let i = 0; i < state.pool.length; i++) {
    state.cursor = (state.cursor + 1) % state.pool.length
    const proxy = state.pool[state.cursor]
    if ((state.badUntil.get(proxy) || 0) > now) continue
    if ((state.inFlight.get(proxy) || 0) >= MAX_PER_PROXY) continue
    return proxy
  }
  return null
}

/** URL de proxy prête pour curl_cffi / requests (schéma http://). */
function getProxyUrl(proxy) {
  return proxy ? `http://${proxy}` : null
}

function getStatus() {
  return {
    enabled: state.enabled,
    poolSize: state.pool.length,
    banned: state.badUntil.size,
    quality: getQuality(),
    degraded: isDegraded(),
    attempts: state.attempts.length,
    allowlist: (process.env.FREE_PROXY_ALLOWLIST
      ? process.env.FREE_PROXY_ALLOWLIST.split(',')
      : DEFAULT_ALLOWLIST
    ).map((s) => s.trim()).filter(Boolean),
  }
}

// ── Réseau ──────────────────────────────────────────────────────

function _fetchListUrl(url, timeoutMs) {
  return new Promise((resolve) => {
    let out = ''
    const req = https.get(
      url,
      {
        timeout: timeoutMs,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HamdiProno/1.0)' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          return resolve('')
        }
        res.setEncoding('utf8')
        res.on('data', (c) => (out += c))
        res.on('end', () => resolve(out))
      }
    )
    req.on('error', () => resolve(''))
    req.on('timeout', () => {
      req.destroy()
      resolve('')
    })
  })
}

async function _fetchLists() {
  const merged = []
  const seen = new Set()
  for (const url of LIST_URLS) {
    const text = await _fetchListUrl(url, FETCH_TIMEOUT_MS)
    for (const p of parseProxyList(text)) {
      if (!seen.has(p)) {
        seen.add(p)
        merged.push(p)
      }
    }
  }
  return merged
}

/** Tunnel CONNECT vers un hôte HTTPS via un proxy HTTP (Node pur). */
function _connectTunnel(targetHost, targetPort, proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    const [ph, pp] = proxy.split(':')
    const sock = net.connect({ host: ph, port: Number(pp) })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('proxy_connect_timeout'))
    }, timeoutMs)
    sock.once('connect', () => {
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`)
    })
    let buf = ''
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1')
      if (buf.includes('\r\n\r\n')) {
        clearTimeout(timer)
        const statusLine = buf.slice(0, buf.indexOf('\r\n'))
        const code = parseInt((statusLine.split(' ')[1] || '0'), 10)
        if (code === 200) resolve(sock)
        else {
          sock.destroy()
          reject(new Error(`proxy_connect_${code}`))
        }
      }
    })
    sock.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    sock.on('close', () => clearTimeout(timer))
  })
}

/** Fetch HTTPS complet via un proxy HTTP (CONNECT + TLS + GET). */
function fetchTextThroughProxy(url, proxy, timeoutMs = REQUEST_TIMEOUT_MS) {
  const u = new URL(url)
  if (u.protocol !== 'https:') return Promise.reject(new Error('https_only'))
  const port = u.port || 443
  return new Promise((resolve, reject) => {
    _connectTunnel(u.hostname, port, proxy, Math.min(timeoutMs, HEALTH_TIMEOUT_MS + 1000))
      .then((sock) => {
        const tlsSock = tls.connect({ socket: sock, servername: u.hostname })
        const timer = setTimeout(() => {
          tlsSock.destroy()
          reject(new Error('tls_timeout'))
        }, timeoutMs)
        let settled = false
        tlsSock.once('secureConnect', () => {
          clearTimeout(timer)
          const path = u.pathname + u.search
          const reqHead =
            `GET ${path} HTTP/1.1\r\n` +
            `Host: ${u.host}\r\n` +
            'Connection: close\r\n' +
            'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36\r\n' +
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n' +
            'Accept-Language: en-US,en;q=0.9,fr;q=0.8\r\n\r\n'
          let res = ''
          let headersDone = false
          tlsSock.on('data', (d) => {
            res += d.toString('utf8')
            if (!headersDone && res.includes('\r\n\r\n')) {
              headersDone = true
              const head = res.slice(0, res.indexOf('\r\n\r\n'))
              const status = parseInt((head.split('\r\n')[0].split(' ')[1] || '0'), 10)
              if (status >= 400) {
                settled = true
                clearTimeout(timer)
                tlsSock.destroy()
                reject(new Error(`http_${status}`))
              }
            }
          })
          tlsSock.on('close', () => {
            clearTimeout(timer)
            if (settled) return
            if (!headersDone) return reject(new Error('closed_before_headers'))
            const idx = res.indexOf('\r\n\r\n')
            const status = parseInt((res.split('\r\n')[0].split(' ')[1] || '0'), 10)
            resolve({ status, body: idx >= 0 ? res.slice(idx + 4) : '', proxy })
          })
          tlsSock.on('error', (e) => {
            clearTimeout(timer)
            reject(e)
          })
          tlsSock.write(reqHead)
        })
        tlsSock.on('error', (e) => {
          clearTimeout(timer)
          reject(e)
        })
      })
      .catch(reject)
  })
}

function _healthCheck(proxy) {
  return fetchTextThroughProxy('https://api.ipify.org?format=json', proxy, HEALTH_TIMEOUT_MS)
    .then((r) => r && r.status === 200)
    .catch(() => false)
}

async function refreshPool() {
  if (!state.enabled || state.refreshing) return
  state.refreshing = true
  try {
    const candidates = await _fetchLists()
    const verified = []
    let idx = 0
    const worker = async () => {
      while (idx < Math.min(candidates.length, HEALTH_CANDIDATES)) {
        const proxy = candidates[idx++]
        const ok = await _healthCheck(proxy)
        if (ok) {
          verified.push(proxy)
          if (verified.length >= MAX_POOL) break
        }
      }
    }
    await Promise.all(Array.from({ length: HEALTH_PARALLEL }, worker))
    state.pool = verified
    state.lastRefresh = Date.now()
    const cutoff = Date.now() - REFRESH_MS
    state.attempts = state.attempts.filter((a) => a.ts >= cutoff)
  } catch (_) {
    // On garde le pool précédent ; ne jamais casser la chaîne.
  } finally {
    state.refreshing = false
  }
}

function _acquire() {
  const proxy = getProxy()
  if (!proxy) return null
  state.inFlight.set(proxy, (state.inFlight.get(proxy) || 0) + 1)
  return proxy
}

function _release(proxy) {
  if (!proxy) return
  const n = state.inFlight.get(proxy) || 0
  if (n <= 1) state.inFlight.delete(proxy)
  else state.inFlight.set(proxy, n - 1)
}

/**
 * Fetch texte HTTPS via le pool de proxys (rotation + blacklist).
 * Retourne { status, body, proxy } ou null si indisponible/désactivé/bloqué.
 */
async function fetchText(url, opts = {}) {
  if (!state.enabled) return null
  if (!isAllowedUrl(url)) return null
  const timeout = opts.timeout || REQUEST_TIMEOUT_MS
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS
  await refreshPool()
  if (state.pool.length === 0) return null

  let proxy = _acquire()
  let attempts = 0
  while (proxy && attempts < maxAttempts) {
    attempts++
    try {
      const res = await fetchTextThroughProxy(url, proxy, timeout)
      if (res && res.status === 200) {
        recordAttempt(true)
        return res
      }
      markBad(proxy)
      recordAttempt(false)
    } catch (_) {
      markBad(proxy)
      recordAttempt(false)
    } finally {
      _release(proxy)
    }
    proxy = _acquire()
  }
  if (proxy) _release(proxy)
  return null
}

function isEnabled() {
  return state.enabled
}

function reset() {
  state.pool = []
  state.badUntil = new Map()
  state.inFlight = new Map()
  state.cursor = 0
  state.lastRefresh = 0
  state.attempts = []
  state.refreshing = false
}

module.exports = {
  isEnabled,
  getProxy,
  getProxyUrl,
  fetchText,
  fetchTextThroughProxy,
  isAllowedUrl,
  parseProxyList,
  getQuality,
  isDegraded,
  recordAttempt,
  markBad,
  getStatus,
  refreshPool,
  reset,
  _internal: {
    __setEnabled: (v) => {
      state.enabled = !!v
    },
    __setPool: (list) => {
      state.pool = list || []
      state.lastRefresh = Date.now()
    },
    __getState: () => state,
  },
}