/**
 * theAnalystClient.js — client de l'API publique performfeeds (Stats Perform)
 * utilisée par les widgets Opta de https://theanalyst.com (dataviz.theanalyst.com).
 *
 * La clé (`outletAuthKey`) et le mapping ligues→tmcl sont extraits du bundle
 * public du widget (the-analyst-sdapi) ; l'accès reproduit EXACTEMENT celui du
 * navigateur (Referer https://theanalyst.com/ + UA + JSONP). Aucune donnée
 * payante : c'est le flux que le site sert lui-même à ses visiteurs.
 *
 * Produit : probabilités Opta 1X2 par matchs à venir (période 16 = upcoming)
 *   - endpoint `match`               -> liste des matchs d'une ligue (window)
 *   - endpoint `matchlivewinprobability` -> {Home, Draw, Away} par matchId
 *
 * Conventions projet : CommonJS, pas de dépendance HTTP externe (fetch global
 * Node >= 18), retry/backoff + circuit breaker comme les autres sources.
 */
const logger = require('../core/logger')

const BASE_URL = 'https://api.performfeeds.com'
const DATAPOOL = 'soccerdata'
const OUTLET_AUTH_KEY =
  process.env.THE_ANALYST_AUTH_KEY || '1mjq6w6ezkxe611ykkj8rgz7f1'
const REFERER = 'https://theanalyst.com/'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const CONNECT_TIMEOUT_MS = Number(process.env.THE_ANALYST_TIMEOUT_MS || 15000)
const MAX_RETRIES = Number(process.env.THE_ANALYST_RETRIES || 3)
const RETRY_BASE_MS = Number(process.env.THE_ANALYST_RETRY_MS || 1500)
const RATE_MS = Number(process.env.THE_ANALYST_RATE_MS || 1500)
// Valeur max tolérée par l'API (le widget utilise 380 ; 500 -> 413/10219).
const PAGE_SIZE = Number(process.env.THE_ANALYST_PAGE_SIZE || 380)

// Circuit breaker : 8 échecs consécutifs -> suspendu 5 min.
const MAX_CONSEC_FAILURES = 8
const BREAK_MS = Number(process.env.THE_ANALYST_BREAK_MS || 300000)

// Map ligue (code DB-ish) -> identifiant `tmcl` du widget (extrait du bundle).
const LEAGUES = [
  { code: 'EPL', label: 'Premier League', tmcl: '6pdwluctev9iebv00r4qqukno' },
  { code: 'BUN', label: 'Bundesliga', tmcl: '8h5xijv2u4mlf5028gso6kw7o' },
  { code: 'LI1', label: 'Ligue 1', tmcl: 'bqnc4ccgnrp6pb3bktqet0yz8' },
  { code: 'LL', label: 'La Liga', tmcl: '830epggffy1nfkfyrtpqdwhlg' },
  { code: 'SEA', label: 'Serie A', tmcl: '60cryos85i4bp5ul34tt0brx0' },
  { code: 'CHA', label: 'Championship', tmcl: 'al48ooi8acoibema226051250' },
  { code: 'LEO', label: 'League One', tmcl: 'b7amy99ea2lpnx81o6q94pst0' },
  { code: 'LET', label: 'League Two', tmcl: '7kjvvls20hnhjguys4t73yjh0' },
  { code: 'LEC', label: 'EFL Cup', tmcl: 'dap7q17azs3j8a5sv36enfr4k' },
  { code: 'MLS', label: 'MLS', tmcl: '6i6n0jkbh9zzij6s8htfjh2j8' },
  { code: 'UCL', label: 'Champions League', tmcl: '99jev9kv55deht65t6myggxlg' },
  { code: 'UEL', label: 'Europa League', tmcl: '1rpi0q64a7kut2wiuvecmgbv8' },
  { code: 'UCF', label: 'Conference League', tmcl: 'acatl9aedc5l4im3r8l890y6s' },
  { code: 'WSL', label: 'Women Super League', tmcl: 'b98jgqlofjpbpvjb8hk20z3tg' },
  { code: 'UWC', label: 'Women Champions League', tmcl: '5adv3fudi08uv5zl9nmux6kgk' },
  { code: 'EFA', label: 'FA Cup', tmcl: '75p5723yryew2ywn0isvf7cic' },
  { code: 'WC', label: 'FIFA World Cup', tmcl: '873cbl9cd9butm4air0mugxzo' },
  { code: 'COS', label: 'Community Shield', tmcl: '5ceeum43bprquzd6cc1ydhwyc' },
]

const isEnabled = () =>
  String(process.env.THE_ANALYST_ENABLED || '')
    .trim()
    .toLowerCase() === 'on'

// ─── helpers purs (testables) ────────────────────────────────────────────────

function parseJsonp(text) {
  if (typeof text !== 'string') return null
  let s = text.trim()
  const open = s.indexOf('(')
  const close = s.lastIndexOf(')')
  if (open >= 0 && close > open) s = s.slice(open + 1, close)
  try {
    return JSON.parse(s)
  } catch (e) {
    return null
  }
}

function normProb(v) {
  const f = parseFloat(String(v).replace('%', ''))
  return Number.isFinite(f) ? Math.round(f * 1000) / 1000 : null
}

function buildUrl(endpoint, opts = {}, appendToHref) {
  let u = `${BASE_URL}/${DATAPOOL}/${endpoint}/${OUTLET_AUTH_KEY}`
  if (appendToHref) u += `/${appendToHref}`
  const p = new URL(u)
  p.searchParams.set('_rt', 'c')
  p.searchParams.set('_fmt', 'jsonp')
  // `_clbk` doit être un identifiant JS VALIDE (sans tiret) : l'API (performfeeds)
  // rejette en 401 les callbacks contenant `-` (validé en live, E69).
  p.searchParams.set('_clbk', `cbsoccerdata_${endpoint}_${Math.random().toString(36).slice(2, 8)}`)
  for (const [k, v] of Object.entries(opts)) p.searchParams.set(k, String(v))
  return p
}

function toDateWindow(horizonDays = 4) {
  const now = new Date()
  const back = new Date(now.getTime() - horizonDays * 86400000)
  const fwd = new Date(now.getTime() + horizonDays * 86400000)
  const iso = (d) => d.toISOString().slice(0, 10)
  return `[${iso(back)}T00:00:00Z TO ${iso(fwd)}T00:00:00Z]`
}

function toKickoffMs(date, time) {
  const d = String(date || '').replace(/Z$/, '')
  const t = String(time || '')
  const s = `${d}T${t}`
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : 0
}

// 1X2 à partir du payload `matchlivewinprobability` / `preMatchPredictions`.
function extractOneXTwo(liveData) {
  if (!liveData || !Array.isArray(liveData.preMatchPredictions)) return null
  const preds = liveData.preMatchPredictions[0]
  if (!preds || !Array.isArray(preds.prediction)) return null
  const map = {}
  for (const p of preds.prediction) map[String(p.type).toLowerCase()] = normProb(p.probability)
  const { home, draw, away } = map
  if (home == null || draw == null || away == null) return null
  return { home, draw, away }
}

// ─── state (observabilité) ───────────────────────────────────────────────────

const state = {
  lastRunAt: null,
  lastRunMs: 0,
  leaguesScanned: 0,
  matchesSeen: 0,
  withPredictions: 0,
  errors: 0,
  skippedAuth: 0,
  wrote: 0,
  consecutiveFailures: 0,
  breakerUntil: 0,
  lastError: null,
}

function getStatus() {
  return { enabled: isEnabled(), ...state, LEAGUES: LEAGUES.length }
}

function _notify(err) {
  state.consecutiveFailures++
  state.lastError = err && err.message ? err.message : String(err)
  if (state.consecutiveFailures >= MAX_CONSEC_FAILURES) {
    state.breakerUntil = Date.now() + BREAK_MS
    logger.warn(`[THEANALYST] Circuit breaker OPEN (${BREAK_MS}ms) — ${state.lastError}`)
  }
}

function _notifyOk() {
  state.consecutiveFailures = 0
  state.breakerUntil = 0
}

// ─── transport (injectable pour les tests) ───────────────────────────────────

// NOTE (E69, validé en live) : le `fetch` global (undici) déclenche un 401
// (errorCode 10202) sur api.performfeeds.com, alors que le MÊME URL via
// `https.request` HTTP/1.1 (browser-like) répond 200. Le transport par défaut
// utilise donc le module `https` natif (headers minimaux, comme un navigateur).
const httpMods = {
  'https:': require('https'),
  'http:': require('http'),
}

function _defaultTransport({ url, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    if (!httpMods[u.protocol]) return reject(new Error(`unsupported protocol ${u.protocol}`))
    const req = httpMods[u.protocol].request(
      u,
      {
        method: 'GET',
        headers: { 'User-Agent': UA, Referer: REFERER, Accept: '*/*' },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            text: async () => body,
          })
        )
      }
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error('theAnalyst timeout')))
    req.on('error', (e) => {
      req.destroy()
      reject(e)
    })
    req.end()
  })
}

let _transport = _defaultTransport

function setTransport(fn) {
  _transport = fn
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Pause de courtoisie (RATE_MS + jitter 0-40%) pour ne pas marteler le flux.
const politeness = () => RATE_MS + Math.round(Math.random() * RATE_MS * 0.4)

// ─── requête avec retry/backoff modernisé ────────────────────────────────────

async function requestJsonp(url, { retries = MAX_RETRIES, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  let lastErr = null
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (attempt > 1) await sleep(RETRY_BASE_MS * attempt)
    try {
      const res = await _transport({ url: url.toString(), timeoutMs })
      const text = typeof res.text === 'function' ? await res.text() : String(res)
      const payload = parseJsonp(text)
      if (res.ok === false) {
        if (res.status === 404) return null // pas de donnée pour ce scope
        lastErr = new Error(`theAnalyst http ${res.status}`)
        _notify(lastErr)
        continue
      }
      // Erreurs "métier" renvoyées comme JSONP : {"httpStatus":"401","errorCode":"10202"}
      if (payload && payload.errorCode && payload.httpStatus) {
        if (String(payload.httpStatus) === '404') return null // pas de donnée
        if (String(payload.httpStatus) === '401') {
// 401 (10202) est TRANSIENT sur ce flux (throttle/fenêtre) : on retente
        // UNE fois (politesse), puis on considère l'auth indisponible.
        lastErr = new Error(`theAnalyst auth (${payload.errorCode})`)
        _notify(lastErr)
        if (attempt < Math.min(2, retries)) continue
        return { _authError: true }
        }
        lastErr = new Error(`theAnalyst api error ${payload.httpStatus}/${payload.errorCode}`)
        _notify(lastErr)
        continue
      }

      _notifyOk()
      return payload || {}
    } catch (e) {
      lastErr = e
      _notify(e)
      if (attempt >= retries) break
    }
  }
  if (lastErr) throw lastErr
  return {}
}

// ─── endpoints ----------------------------------------------------------------

/**
 * Liste des matchs à venir (periodId === 16) d'une ligue sur la fenêtre courante.
 * @returns {Promise<Array<{matchId,leagueCode,league,home,away,kickoffMs}>>}
 */
async function fetchLeagueMatches(league, { horizonDays = 4 } = {}) {
  const url = buildUrl('match', {
    tmcl: league.tmcl,
    live: 'yes',
    _pgSz: PAGE_SIZE,
    'mt.mDt': toDateWindow(horizonDays),
  })
  const d = await requestJsonp(url)
  if (!d || d._authError || !Array.isArray(d.match)) return []
  const out = []
  for (const m of d.match) {
    const mi = m && m.matchInfo
    if (!mi || !Array.isArray(mi.contestant) || mi.contestant.length < 2) continue
    if (Number(m.liveData && m.liveData.matchDetails && m.liveData.matchDetails.periodId) !== 16) continue
    const kickoffMs = toKickoffMs(mi.date, mi.time)
    if (!kickoffMs) continue
    out.push({
      matchId: mi.id,
      leagueCode: league.code,
      league: league.label,
      home: mi.contestant[0].name,
      away: mi.contestant[1].name,
      kickoffMs,
    })
  }
  return out
}

/**
 * Probabilités Opta 1X2 pour un matchId via `matchlivewinprobability`.
 * @returns {Promise<{home,draw,away}|null>}
 */
async function fetchMatchPredictions(matchId) {
  const url = buildUrl('matchlivewinprobability', {}, matchId)
  const d = await requestJsonp(url)
  if (!d || d._authError || !d.liveData) return null
  return extractOneXTwo(d.liveData)
}

/**
 * Passe complète : toutes les ligues -> matchs à venir -> probas 1X2.
 * On peut limiter le nombre de ligues (maxLeagues) pour les tests / dry-runs.
 */
async function fetchAll({ horizonDays = 4, maxLeagues = LEAGUES.length, onMatch = null } = {}) {
  const started = Date.now()
  state.lastRunAt = new Date().toISOString()
  state.leaguesScanned = 0
  state.matchesSeen = 0
  state.withPredictions = 0
  state.errors = 0
  state.skippedAuth = 0
  state.wrote = 0

  const results = []
  if (state.breakerUntil > Date.now()) {
    const msg = `circuit breaker until ${new Date(state.breakerUntil).toISOString()}`
    state.lastError = msg
    return { breaker: msg, results: [] }
  }

  const leagues = LEAGUES.slice(0, maxLeagues)
  for (const league of leagues) {
    if (state.breakerUntil > Date.now()) break
    let matches = []
    try {
      matches = await fetchLeagueMatches(league, { horizonDays })
      // Délai de courtoisie entre ligues (à nouveau, comme le widget).
      await sleep(politeness())
    } catch (e) {
      state.errors++
      logger.warn(`[THEANALYST] fetchLeagueMatches ${league.code}: ${e.message}`)
      continue
    }
    state.leaguesScanned++
    state.matchesSeen += matches.length
    for (const m of matches) {
      try {
        const probs = await fetchMatchPredictions(m.matchId)
        if (!probs) continue
        const row = {
          ...m,
          prob_home: probs.home,
          prob_draw: probs.draw,
          prob_away: probs.away,
        }
        results.push(row)
        state.withPredictions++
        if (onMatch) onMatch(row)
} catch (e) {
          state.errors++
          logger.warn(`[THEANALYST] predict ${m.matchId}: ${e.message}`)
        }
        await sleep(politeness())
    }
  }

  state.lastRunMs = Date.now() - started
  if (state.errors === 0) state.lastError = null
  return { results }
}

module.exports = {
  client: {
    isEnabled,
    getStatus,
    fetchLeagueMatches,
    fetchMatchPredictions,
    fetchAll,
  },
  LEAGUES,
  parseJsonp,
  extractOneXTwo,
  normProb,
  toDateWindow,
  toKickoffMs,
  buildUrl,
  setTransport,
  state,
}
