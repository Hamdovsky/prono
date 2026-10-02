/**
 * Crawl4aiScraper.js — Scrape Sofascore Web via Crawl4AI (:11235)
 *
 * Remplace Firecrawl (payant) + Jina Reader (20 req/min) + allege Puppeteer
 * pour www.sofascore.com/* (odds, standings, shotmap — JS-lourd + WAF).
 * Ne touche PAS a l'API JSON api.sofascore.com (sofascore_bypass.py).
 *
 * Architecture : Node -> POST http://127.0.0.1:11235/{md|crawl|llm-extract}
 *   (CRAWL4AI_URL, interchangeable local venv ou Docker unclecode/crawl4ai)
 *   -> scripts/crawl4ai_service.py (.venv-crawl4ai + Playwright) -> www.sofascore.com
 *
 * Env:
 *   CRAWL4AI_ENABLED=off (defaut, local only, comme ODDSPORTAL_ENABLED)
 *   CRAWL4AI_URL=http://127.0.0.1:11235
 *   CRAWL4AI_API_TOKEN= (vide = localhost sans auth)
 *   CRAWL4AI_CONCURRENCY=2 (cote service, memoire 300-600 Mo/page)
 */
const http = require('http')
const https = require('https')

const resolver = require('../../core/utils/crawl4aiResolver')

const CACHE_TTL = 10 * 60 * 1000
const MAX_CACHE = 100
const CIRCUIT_THRESHOLD = 100
const CIRCUIT_TIMEOUT = 30 * 1000
const PAGE_TIMEOUT = 45000

let circuitState = { failures: 0, lastFailure: 0, state: 'CLOSED' }
const cache = new Map()
let challengeLoggedAt = 0
const CHALLENGE_LOG_THROTTLE_MS = 5 * 60 * 1000

/**
 * Le WAF Sofascore sert "Verifying you are human..." (HTTP 302) au lieu des
 * cotes. Ce n'est pas recuperable en local : il faut un Chromium headful
 * (CRAWL4AI_HEADLESS=0 au lancement du service) ou une IP residentielle.
 * On le signale une fois toutes les 5 min pour ne pas noyer les logs.
 */
function logChallengeOnce(url) {
  const now = Date.now()
  if (now - challengeLoggedAt < CHALLENGE_LOG_THROTTLE_MS) return
  challengeLoggedAt = now
  console.warn(
    '[CRAWL4AI] WAF Sofascore (challenge anti-bot) sur ' +
      url +
      ' -> relance le service avec CRAWL4AI_HEADLESS=0, ou laisse les paliers bypass/jina'
  )
}

// ── Circuit breaker (copie ScrapingBypassScraper) ──────────────────────────────
function isCircuitOpen() {
  if (circuitState.state === 'CLOSED') return false
  if (circuitState.state === 'HALF_OPEN') return false
  if (Date.now() - circuitState.lastFailure > CIRCUIT_TIMEOUT) {
    circuitState.state = 'HALF_OPEN'
    console.warn('[CRAWL4AI] Circuit HALF-OPEN')
    return false
  }
  return true
}
function recordFailure() {
  circuitState.failures++
  circuitState.lastFailure = Date.now()
  if (circuitState.failures >= CIRCUIT_THRESHOLD) {
    circuitState.state = 'OPEN'
    console.error('[CRAWL4AI] Circuit OPEN after ' + circuitState.failures + ' failures')
  }
}
function recordSuccess() {
  if (circuitState.state === 'HALF_OPEN') console.warn('[CRAWL4AI] Circuit CLOSED')
  circuitState.failures = 0
  circuitState.state = 'CLOSED'
}
function resetCircuitBreaker() {
  circuitState = { failures: 0, lastFailure: 0, state: 'CLOSED' }
}

// ── Cache ─────────────────────────────────────────────────────────────────────
function cacheGet(key) {
  const e = cache.get(key)
  if (!e) return undefined
  if (Date.now() - e.ts > CACHE_TTL) {
    cache.delete(key)
    return undefined
  }
  cache.delete(key)
  cache.set(key, e)
  return e.data
}
function cacheSet(key, data) {
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  cache.set(key, { data, ts: Date.now() })
}
function getCacheSize() { return cache.size }
function clearCache() { cache.clear() }

// ── Helpers ───────────────────────────────────────────────────────────────────
function normKey(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function isCrawl4aiEnabled() {
  return resolver.isCrawl4aiEnabled()
}

/**
 * Lecture synchrone de la disponibilite : flag + circuit breaker + cache de
 * health. Ne declenche aucune requete (les appelants sync comme
 * getPriorityChain ne peuvent pas await) ; avant toute sonde le cache est
 * "non sonde" et on reste optimiste, refreshHealth() tranche ensuite.
 */
function isAvailable() {
  if (!isCrawl4aiEnabled()) return false
  if (isCircuitOpen()) return false
  const cached = resolver.getCachedHealth()
  if (!cached.probed) return true
  return cached.ok
}

/** Disponibilite reelle : sonde /health (<= 2 s, cache 30 s). */
async function isAvailableAsync() {
  if (!isCrawl4aiEnabled()) return false
  if (isCircuitOpen()) return false
  return resolver.isAvailable({ timeoutMs: 2000 })
}

/** Rechauffe le cache de health sans await (appelable depuis un contexte sync). */
function refreshHealth(opts) {
  if (!isCrawl4aiEnabled()) return Promise.resolve(false)
  return resolver.refreshHealth({ timeoutMs: 2000, ...(opts || {}) })
}

function postJson(endpoint, payload, timeoutMs) {
  const base = resolver.getCrawl4aiUrl()
  const url = base + endpoint
  const body = JSON.stringify(payload)
  const token = String(process.env.CRAWL4AI_API_TOKEN || '').trim()
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url)
      const mod = parsed.protocol === 'https:' ? https : http
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
      if (token) headers['Authorization'] = 'Bearer ' + token
      const req = mod.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: 'POST',
          timeout: timeoutMs || 35000,
          headers,
        },
        (res) => {
          let data = ''
          res.on('data', (c) => (data += c))
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new Error('Crawl4AI HTTP ' + res.statusCode + ': ' + data.slice(0, 400)))
            }
            try {
              resolve(JSON.parse(data))
            } catch (e) {
              reject(new Error('Invalid JSON from Crawl4AI: ' + e.message))
            }
          })
        }
      )
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Crawl4AI timeout after ' + timeoutMs + 'ms'))
      })
      req.write(body)
      req.end()
    } catch (e) {
      reject(e)
    }
  })
}

// User-Agent Chrome recent : le WAF Sofascore (challenge "Verifying you are
// human" + HTTP 302) rejette les UA par defaut de Playwright/headless.
const DEFAULT_SOFASCORE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// Lu a l'appel (pas au chargement du module) pour qu'un changement d'env en
// cours de process soit pris en compte.
function resolveUserAgent() {
  return String(process.env.CRAWL4AI_USER_AGENT || '').trim() || DEFAULT_SOFASCORE_UA
}

// Attendue que le DOM de la page cotes soit monte avant extraction.
function resolveWaitFor() {
  return (
    String(process.env.CRAWL4AI_WAIT_FOR || '').trim() ||
    "div[class*='Odds'], div[class*='odds'], div[class*='event']"
  )
}

/**
 * Construit le bloc crawler_config accepte par le service (:11235).
 * Liste blanche cote Python : wait_for / wait_until / css_selector /
 * excluded_selector / excluded_tags / user_agent / locale (+ booleens et
 * timings). Tout le reste est ignore silencieusement.
 */
function buildCrawlerConfig(extra) {
  return Object.assign(
    {
      user_agent: resolveUserAgent(),
      locale: 'en-US',
      wait_until: 'domcontentloaded',
    },
    extra || {}
  )
}

/**
 * Bloc browser_config envoye au service. Le WAF Sofascore resout beaucoup
 * mieux le challenge en mode visible ; headless etant un argument de lancement
 * Chromium, le service ne relance son navigateur que si le mode change — donc
 * le cout est one-shot, pas par requete.
 */
function buildBrowserConfig() {
  const headful = ['1', 'on', 'true', 'yes'].includes(
    String(process.env.CRAWL4AI_HEADFUL || '').trim().toLowerCase()
  )
  return headful ? { headless: false } : {}
}

// Le WAF Sofascore sert cette page de verification au lieu du contenu. La
// detecter evite d'epuiser les 2 URLs x 2 strategies sur un bloc garanti.
const CHALLENGE_MARKERS = [
  'verifying you are human',
  'please verify you are human',
  'checking your browser',
  'just a moment',
  'enable javascript and cookies to continue',
]

function isChallengePage(markdown) {
  const text = String(markdown || '').toLowerCase()
  if (!text) return false
  return CHALLENGE_MARKERS.some((m) => text.includes(m))
}

async function fetchMarkdown(targetUrl, opts = {}) {
  const payload = {
    url: targetUrl,
    f: opts.filter || 'fit',
    c: '0',
    browser_config: buildBrowserConfig(),
    crawler_config: buildCrawlerConfig(opts.waitFor ? { wait_for: opts.waitFor } : null),
  }
  const res = await postJson('/md', payload, opts.timeoutMs || 30000)
  // Le service a deja detecte le challenge WAF : on leve l'erreur pour que
  // l'appelant corte la boucle au lieu de parser une page de verification.
  if (res && res.challenge) throw new Error('challenge_anti_bot')
  if (res && res.success && typeof res.markdown === 'string') return res.markdown
  if (res && typeof res.markdown === 'string') return res.markdown
  return null
}

// ── Schemas CSS (V1 odds prioritaire, autres definis pour C futur) ───────────
const SOFASCORE_ODDS_CSS = {
  baseSelector: 'body',
  fields: [
    { name: 'raw_text', selector: 'body', attribute: 'text' },
  ],
}

const SOFASCORE_EVENT_CSS = {
  baseSelector: 'body',
  fields: [
    { name: 'raw_text', selector: 'body', attribute: 'text' },
  ],
}

const SOFASCORE_STATS_CSS = {
  baseSelector: 'body',
  fields: [
    { name: 'raw_text', selector: 'body', attribute: 'text' },
  ],
}

// Reutilise ODDS_SCHEMA de Firecrawl pour LLM fallback
const ODDS_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          home_team: { type: 'string' },
          away_team: { type: 'string' },
          home_win: { type: 'number', minimum: 1.01 },
          draw: { type: 'number', minimum: 1.01 },
          away_win: { type: 'number', minimum: 1.01 },
          over_25: { type: 'number' },
          under_25: { type: 'number' },
          btts_yes: { type: 'number' },
          btts_no: { type: 'number' },
          bookmaker: { type: 'string' },
        },
        required: ['home_team', 'away_team', 'home_win', 'draw', 'away_win'],
      },
    },
    source_url: { type: 'string' },
    scraped_at: { type: 'string' },
  },
  required: ['matches'],
}

function isLlmEnabled() {
  const provider = String(process.env.CRAWL4AI_LLM_PROVIDER || '').trim()
  const key = String(process.env.OPENROUTER_API_KEY || process.env.VISION_LLM_API_KEY || '').trim()
  return Boolean(provider && key)
}

async function crawlWithCss(targetUrl, schema) {
  const payload = {
    urls: [targetUrl],
    extraction_strategy: { schema },
    browser_config: buildBrowserConfig(),
    crawler_config: buildCrawlerConfig({
      page_timeout: PAGE_TIMEOUT,
      wait_for: resolveWaitFor(),
      wait_for_timeout: 8000,
    }),
  }
  const res = await postJson('/crawl', payload, 40000)
  if (res && res.success && Array.isArray(res.results) && res.results.length > 0) {
    const first = res.results[0]
    // Le service detecte le challenge WAF : pas de recherche de chaine a faire.
    if (first && first.challenge) {
      throw new Error('challenge_anti_bot')
    }
    if (first && first.status_code && isChallengePage(first.extracted_raw)) {
      throw new Error('challenge_anti_bot')
    }
    if (first && first.extracted) return first.extracted
    if (first && first.extracted_raw) return first.extracted_raw
  }
  return null
}

async function crawlWithLlm(targetUrl, schema, instruction) {
  const provider = String(process.env.CRAWL4AI_LLM_PROVIDER || 'openrouter/openai/gpt-4o-mini').trim()
  const payload = {
    url: targetUrl,
    q: instruction,
    schema,
    provider,
    temperature: 0.1,
  }
  const res = await postJson('/llm-extract', payload, 60000)
  if (res && res.success && res.result) return res.result
  return null
}

// ── Markdown parsers (reuse JinaScraper logic) ────────────────────────────────
function extractOddsFromMarkdown(markdown, homeHint, awayHint) {
  const lines = String(markdown || '').split('\n')
  const results = []
  let currentMatch = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const matchPattern = line.match(/^(.+?)\s+(?:vs|VS|v\.|–|-)\s+(.+?)$/)
    if (matchPattern && !line.match(/^\d+\.\d+/)) {
      if (currentMatch && currentMatch.home_win !== null) results.push(currentMatch)
      currentMatch = {
        home_team: matchPattern[1].replace(/^\d+\.\s*/, '').trim(),
        away_team: matchPattern[2].trim(),
        home_win: null,
        draw: null,
        away_win: null,
        over_25: null,
        under_25: null,
        btts_yes: null,
        btts_no: null,
      }
      continue
    }
    if (!currentMatch) continue
    const oddsMatch = line.match(/(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)/)
    if (oddsMatch) {
      const nums = [parseFloat(oddsMatch[1]), parseFloat(oddsMatch[2]), parseFloat(oddsMatch[3])]
      if (nums.every((n) => n >= 1.01 && n <= 20)) {
        if (currentMatch.home_win === null) {
          currentMatch.home_win = nums[0]
          currentMatch.draw = nums[1]
          currentMatch.away_win = nums[2]
        } else if (currentMatch.over_25 === null && nums[0] >= 1.01 && nums[0] <= 10) {
          currentMatch.over_25 = nums[0]
          currentMatch.under_25 = nums[1]
        }
      }
    }
    const ouPattern = line.match(/(?:Over|O\/U|Under)[:\s]+(\d+\.\d+)\s+(\d+\.\d+)/i)
    if (ouPattern && currentMatch.over_25 === null) {
      currentMatch.over_25 = parseFloat(ouPattern[1])
      currentMatch.under_25 = parseFloat(ouPattern[2])
    }
    const bttsPattern = line.match(/(?:BTTS|Both)[:\s]+(\d+\.\d+)\s+(\d+\.\d+)/i)
    if (bttsPattern && currentMatch.btts_yes === null) {
      currentMatch.btts_yes = parseFloat(bttsPattern[1])
      currentMatch.btts_no = parseFloat(bttsPattern[2])
    }
  }
  if (currentMatch && currentMatch.home_win !== null) results.push(currentMatch)
  if (homeHint || awayHint) {
    const hh = (homeHint || '').toLowerCase()
    const ah = (awayHint || '').toLowerCase()
    return results.filter((m) => {
      const hm = (m.home_team || '').toLowerCase()
      const am = (m.away_team || '').toLowerCase()
      const homeOk = !hh || hm.includes(hh) || hh.includes(hm)
      const awayOk = !ah || am.includes(ah) || ah.includes(am)
      return homeOk && awayOk
    })
  }
  return results
}

function extractOddsDirect(markdown) {
  const text = String(markdown || '')
  const direct = {}
  const homeDrawAway = text.match(/1\s*[:\-]?\s*(\d+\.\d+)[^0-9]+X\s*[:\-]?\s*(\d+\.\d+)[^0-9]+2\s*[:\-]?\s*(\d+\.\d+)/i)
  if (homeDrawAway) {
    const nums = [parseFloat(homeDrawAway[1]), parseFloat(homeDrawAway[2]), parseFloat(homeDrawAway[3])]
    if (nums.every((n) => n >= 1.01 && n <= 50)) {
      direct.home_win = nums[0]
      direct.draw = nums[1]
      direct.away_win = nums[2]
    }
  }
  const ou = text.match(/Over\s*2\.5\s*[:\-]?\s*(\d+\.\d+)[^0-9]+Under\s*2\.5\s*[:\-]?\s*(\d+\.\d+)/i)
  if (ou) {
    direct.over_25 = parseFloat(ou[1])
    direct.under_25 = parseFloat(ou[2])
  }
  const btts = text.match(/BTTS[^0-9]*Yes\s*[:\-]?\s*(\d+\.\d+)[^0-9]+No\s*[:\-]?\s*(\d+\.\d+)/i)
  if (btts) {
    direct.btts_yes = parseFloat(btts[1])
    direct.btts_no = parseFloat(btts[2])
  }
  return Object.keys(direct).length > 0 ? direct : null
}

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

function mapExtractedToOdds(extracted) {
  if (!extracted) return null
  let src = extracted
  if (Array.isArray(extracted) && extracted.length > 0) src = extracted[0]
  if (src && src.raw_text && typeof src.raw_text === 'string') {
    const direct = extractOddsDirect(src.raw_text)
    if (direct && hasAnyMarket(direct)) return direct
    return null
  }
  const out = {}
  if (src.home_win != null) out.home_win = Number(src.home_win)
  if (src.draw != null) out.draw = Number(src.draw)
  if (src.away_win != null) out.away_win = Number(src.away_win)
  if (src.over_25 != null) out.over_25 = Number(src.over_25)
  if (src.under_25 != null) out.under_25 = Number(src.under_25)
  if (src.btts_yes != null) out.btts_yes = Number(src.btts_yes)
  if (src.btts_no != null) out.btts_no = Number(src.btts_no)
  if (src.home != null && out.home_win == null) out.home_win = Number(src.home)
  if (src.away != null && out.away_win == null) out.away_win = Number(src.away)
  return hasAnyMarket(out) ? out : null
}

// ── Public API ────────────────────────────────────────────────────────────────
async function getOdds(homeTeam, awayTeam, league, country, date, _proxy) {
  if (!(await isAvailableAsync())) return null
  const cacheKey = 'odds:' + normKey(homeTeam) + '|' + normKey(awayTeam) + '|' + normKey(league)
  const cached = cacheGet(cacheKey)
  if (cached !== undefined) return cached

  let eventId = null
  try {
    const bypass = require('./SofascoreBypass')
    let ts = null
    if (date != null) {
      if (!isNaN(Number(date)) && String(date).length >= 8) ts = Number(date)
      else {
        const parsed = Date.parse(String(date))
        if (!isNaN(parsed)) ts = parsed
      }
    }
    eventId = await bypass.resolveEvent(homeTeam, awayTeam, ts)
  } catch (_) {}

  if (!eventId) {
    cacheSet(cacheKey, null)
    return null
  }

  const urls = [
    'https://www.sofascore.com/event/' + eventId + '/odds',
    'https://www.sofascore.com/event/' + eventId,
  ]

  for (const url of urls) {
    try {
      const extracted = await crawlWithCss(url, SOFASCORE_ODDS_CSS)
      const mapped = mapExtractedToOdds(extracted)
      if (mapped && hasAnyMarket(mapped)) {
        const out = {
          home_win: mapped.home_win || null,
          draw: mapped.draw || null,
          away_win: mapped.away_win || null,
          over_25: mapped.over_25 || null,
          under_25: mapped.under_25 || null,
          btts_yes: mapped.btts_yes || null,
          btts_no: mapped.btts_no || null,
          bookmaker: 'sofascore',
          source: 'sofascore:crawl4ai',
          _scraper: 'crawl4ai',
          scraped_at: new Date().toISOString(),
          match_url: url,
        }
        cacheSet(cacheKey, out)
        recordSuccess()
        console.log('[CRAWL4AI] odds OK ' + homeTeam + ' vs ' + awayTeam + ' via ' + url)
        return out
      }
    } catch (e) {
      if (e.message === 'challenge_anti_bot') {
        logChallengeOnce(url)
        break
      }
      console.warn('[CRAWL4AI] crawlWithCss failed ' + e.message)
    }
    try {
      const md = await fetchMarkdown(url)
      if (isChallengePage(md)) {
        logChallengeOnce(url)
        break
      }
      if (md) {
        const matches = extractOddsFromMarkdown(md, homeTeam, awayTeam)
        if (matches.length > 0 && matches[0].home_win) {
          const m = matches[0]
          const out = {
            home_win: m.home_win,
            draw: m.draw,
            away_win: m.away_win,
            over_25: m.over_25 || null,
            under_25: m.under_25 || null,
            btts_yes: m.btts_yes || null,
            btts_no: m.btts_no || null,
            bookmaker: 'sofascore',
            source: 'sofascore:crawl4ai',
            _scraper: 'crawl4ai',
            scraped_at: new Date().toISOString(),
            match_url: url,
          }
          if (hasAnyMarket(out)) {
            cacheSet(cacheKey, out)
            recordSuccess()
            console.log('[CRAWL4AI] odds OK (md) ' + homeTeam + ' vs ' + awayTeam)
            return out
          }
        }
        const direct = extractOddsDirect(md)
        if (direct && hasAnyMarket(direct)) {
          const out = {
            home_win: direct.home_win || null,
            draw: direct.draw || null,
            away_win: direct.away_win || null,
            over_25: direct.over_25 || null,
            under_25: direct.under_25 || null,
            btts_yes: direct.btts_yes || null,
            btts_no: direct.btts_no || null,
            bookmaker: 'sofascore',
            source: 'sofascore:crawl4ai',
            _scraper: 'crawl4ai',
            scraped_at: new Date().toISOString(),
            match_url: url,
          }
          cacheSet(cacheKey, out)
          recordSuccess()
          console.log('[CRAWL4AI] odds OK (direct) ' + homeTeam + ' vs ' + awayTeam)
          return out
        }
      }
    } catch (e) {
      if (e.message === 'challenge_anti_bot') {
        logChallengeOnce(urls[0])
        break
      }
      console.warn('[CRAWL4AI] fetchMarkdown failed ' + e.message)
    }
  }

  if (isLlmEnabled()) {
    try {
      const url = urls[0]
      const instruction = 'Find the match "' + homeTeam + ' vs ' + awayTeam + '" and extract its 1X2 betting odds (home_win, draw, away_win) as decimal numbers. Also extract Over/Under 2.5 and BTTS odds if visible.'
      const llm = await crawlWithLlm(url, ODDS_SCHEMA, instruction)
      if (llm && llm.matches && llm.matches.length > 0) {
        const hh = normKey(homeTeam)
        const ah = normKey(awayTeam)
        const match = llm.matches.find((m) => {
          const hm = normKey(m.home_team || '')
          const am = normKey(m.away_team || '')
          return (hm.includes(hh) || hh.includes(hm)) && (am.includes(ah) || ah.includes(am))
        }) || llm.matches[0]
        if (match && match.home_win && match.draw && match.away_win) {
          const out = {
            home_win: match.home_win,
            draw: match.draw,
            away_win: match.away_win,
            over_25: match.over_25 || null,
            under_25: match.under_25 || null,
            btts_yes: match.btts_yes || null,
            btts_no: match.btts_no || null,
            bookmaker: match.bookmaker || 'sofascore',
            source: 'sofascore:crawl4ai:llm',
            _scraper: 'crawl4ai',
            scraped_at: new Date().toISOString(),
            match_url: url,
          }
          cacheSet(cacheKey, out)
          recordSuccess()
          console.log('[CRAWL4AI] odds OK (llm) ' + homeTeam + ' vs ' + awayTeam)
          return out
        }
      }
    } catch (e) {
      console.warn('[CRAWL4AI] llm-extract failed ' + e.message)
    }
  }

  recordFailure()
  cacheSet(cacheKey, null)
  return null
}

async function getLiveScores(league) {
  if (!(await isAvailableAsync())) return []
  try {
    const url = 'https://www.sofascore.com/tournament/football/live'
    const md = await fetchMarkdown(url)
    if (!md || isChallengePage(md)) return []
    const matches = extractOddsFromMarkdown(md, null, null)
    return matches.map((m) => ({
      home_team: m.home_team,
      away_team: m.away_team,
      home_score: null,
      away_score: null,
      minute: null,
      status: 'live',
    }))
  } catch (_) {
    return []
  }
}

async function getResults(league) {
  if (!(await isAvailableAsync())) return []
  try {
    const md = await fetchMarkdown('https://www.sofascore.com/')
    if (!md || isChallengePage(md)) return []
    const lines = String(md).split('\n')
    const matches = []
    for (let i = 0; i < lines.length; i++) {
      const scoreLine = lines[i].match(/^(.+?)\s+(\d+)\s*[–-]\s*(\d+)\s+(.+)$/)
      if (scoreLine) {
        matches.push({
          home_team: scoreLine[1].trim(),
          home_score: parseInt(scoreLine[2]),
          away_score: parseInt(scoreLine[3]),
          away_team: scoreLine[4].trim(),
          status: 'finished',
        })
      }
    }
    return matches
  } catch (_) {
    return []
  }
}

async function scrapeUrl(targetUrl) {
  if (!(await isAvailableAsync())) return null
  try {
    const md = await fetchMarkdown(targetUrl)
    // Ne jamais renvoyer la page de verification WAF comme si c'etait du contenu.
    if (md && isChallengePage(md)) {
      logChallengeOnce(targetUrl)
      return null
    }
    if (md) {
      recordSuccess()
      return { markdown: md, url: targetUrl, source: 'crawl4ai:md' }
    }
    const extracted = await crawlWithCss(targetUrl, SOFASCORE_ODDS_CSS)
    if (extracted) {
      recordSuccess()
      return { extracted, url: targetUrl, source: 'crawl4ai:crawl' }
    }
  } catch (e) {
    if (e.message === 'challenge_anti_bot') {
      logChallengeOnce(targetUrl)
      return null
    }
    recordFailure()
    console.warn('[CRAWL4AI] scrapeUrl failed ' + e.message)
  }
  recordFailure()
  return null
}

module.exports = {
  getOdds,
  getLiveScores,
  getResults,
  scrapeUrl,
  isAvailable,
  isAvailableAsync,
  refreshHealth,
  getCacheSize,
  clearCache,
  resetCircuitBreaker,
  fetchMarkdown,
  // Exposed for testing
  _recordFailure: recordFailure,
  _recordSuccess: recordSuccess,
  _isCircuitOpen: isCircuitOpen,
  _getCircuitState: () => ({ ...circuitState }),
  _isChallengePage: isChallengePage,
  _buildCrawlerConfig: buildCrawlerConfig,
  _buildBrowserConfig: buildBrowserConfig,
  _resolveUserAgent: resolveUserAgent,
  _resolveWaitFor: resolveWaitFor,
  _DEFAULT_SOFASCORE_UA: DEFAULT_SOFASCORE_UA,
  _extractOddsFromMarkdown: extractOddsFromMarkdown,
  _extractOddsDirect: extractOddsDirect,
  _hasAnyMarket: hasAnyMarket,
  _SOFASCORE_ODDS_CSS: SOFASCORE_ODDS_CSS,
  _SOFASCORE_EVENT_CSS: SOFASCORE_EVENT_CSS,
  _SOFASCORE_STATS_CSS: SOFASCORE_STATS_CSS,
  _ODDS_SCHEMA: ODDS_SCHEMA,
}
