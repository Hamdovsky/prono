/**
 * FirecrawlScraper.js — Primary dynamic scraper
 * 
 * Uses Firecrawl API with LLM extraction for JS-heavy sites.
 * Target: Flashscore (live scores, odds), OddsPortal, Bet365
 * 
 * Requires: FIRECRAWL_API_KEY in .env
 * Free tier: 500-1000 credits/mo, no card needed
 * 
 * Schema-driven extraction: returns structured JSON via LLM.
 */

const https = require('https')
const http = require('http')

const SCRAPE_CACHE = new Map()
const CACHE_TTL = 10 * 60 * 1000 // 10 min (odds change fast)

// ── Strict JSON Schemas ──────────────────────────────────────────

const ODDS_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          home_team:  { type: 'string' },
          away_team:  { type: 'string' },
          home_win:   { type: 'number', minimum: 1.01 },
          draw:       { type: 'number', minimum: 1.01 },
          away_win:   { type: 'number', minimum: 1.01 },
          over_25:    { type: 'number' },
          under_25:   { type: 'number' },
          btts_yes:   { type: 'number' },
          btts_no:    { type: 'number' },
          bookmaker:  { type: 'string' },
        },
        required: ['home_team', 'away_team', 'home_win', 'draw', 'away_win'],
      },
    },
    source_url: { type: 'string' },
    scraped_at: { type: 'string' },
  },
  required: ['matches'],
}

const LIVE_SCORES_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          home_team:  { type: 'string' },
          away_team:  { type: 'string' },
          home_score: { type: 'number' },
          away_score: { type: 'number' },
          minute:     { type: 'string' },
          status:     { type: 'string', enum: ['live', 'finished', 'scheduled'] },
        },
        required: ['home_team', 'away_team', 'status'],
      },
    },
  },
}

// ── Helpers ──────────────────────────────────────────────────────

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.request(url, {
      method: options.method || 'GET',
      timeout: options.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': options.auth || '',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...(options.headers || {}),
      },
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers }) }
        catch (e) { resolve({ status: res.statusCode, data, error: e.message }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
    if (options.body) req.write(options.body)
    req.end()
  })
}

// ── URL builders ─────────────────────────────────────────────────

function buildFlashscoreUrls(league) {
  const l = league.toLowerCase()
  const slugs = {
    'world cup': 'world/world-cup',
    'premier league': 'england/premier-league',
    'la liga': 'spain/laliga',
    'serie a': 'italy/serie-a',
    'ligue 1': 'france/ligue-1',
    'bundesliga': 'germany/bundesliga',
    'mls': 'usa/mls',
    'usl championship': 'usa/usl-championship',
    'ligue 2': 'france/ligue-2',
    'championship': 'england/championship',
    'eredivisie': 'netherlands/eredivisie',
    'primeira liga': 'portugal/primeira-liga',
    'brasileirão serie a': 'brazil/serie-a',
    'brasileirão serie b': 'brazil/serie-b',
  }
  const slug = slugs[Object.keys(slugs).find(k => l.includes(k))]
  if (!slug) return { fixtures: null, live: null, odds: null }

  return {
    fixtures: `https://www.flashscore.com/football/${slug}/fixtures/`,
    live: `https://www.flashscore.com/football/${slug}/live/`,
    odds: `https://www.flashscore.com/football/${slug}/odds-comparison/`,
  }
}

// ── Core: Firecrawl extract ──────────────────────────────────────

/**
 * Scrape a URL via Firecrawl with LLM extraction.
 * @param {string} targetUrl - URL to scrape
 * @param {object} schema - JSON schema for extraction
 * @param {string} prompt - LLM prompt describing what to extract
 * @returns {Promise<object>} Extracted structured data
 */
async function extract(targetUrl, schema, prompt) {
  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY not set in .env')

  const body = JSON.stringify({
    url: targetUrl,
    formats: ['extract'],
    extract: {
      schema: schema || ODDS_SCHEMA,
      prompt: prompt || 'Extract all match information including team names and betting odds.',
    },
  })

  const res = await fetchJson('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    timeout: 45000,
    auth: `Bearer ${apiKey}`,
    body,
  })

  if (res.status !== 200) {
    throw new Error(`Firecrawl returned ${res.status}: ${JSON.stringify(res.data)}`)
  }

  if (!res.data.success) {
    throw new Error(`Firecrawl error: ${res.data.error || 'unknown'}`)
  }

  return res.data.data && res.data.data.extract
    ? res.data.data.extract
    : res.data.data
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Get odds from Flashscore via Firecrawl LLM extraction.
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @param {string} league
 * @returns {Promise<object|null>}
 */
async function getOdds(homeTeam, awayTeam, league) {
  const cacheKey = `fc:${homeTeam}|${awayTeam}|${league}`
  const cached = SCRAPE_CACHE.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data

  const urls = buildFlashscoreUrls(league)
  if (!urls.fixtures) return null

  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) return null // Firecrawl not configured — skip silently

  try {
    // Try odds comparison page first, then fixtures
    for (const url of [urls.odds, urls.fixtures].filter(Boolean)) {
      const prompt = `Find the match "${homeTeam} vs ${awayTeam}" and extract its 1X2 betting odds (home_win, draw, away_win) as decimal numbers. Also extract Over/Under 2.5 and BTTS odds if visible.`

      const data = await extract(url, ODDS_SCHEMA, prompt)

      if (data && data.matches) {
        // Fuzzy match our teams
        const hh = homeTeam.toLowerCase()
        const ah = awayTeam.toLowerCase()
        const match = data.matches.find(m => {
          const hm = (m.home_team || '').toLowerCase()
          const am = (m.away_team || '').toLowerCase()
          return (hm.includes(hh) || hh.includes(hm)) &&
                 (am.includes(ah) || ah.includes(am))
        })

        if (match && match.home_win && match.draw && match.away_win) {
          const result = {
            home_win: match.home_win,
            draw: match.draw,
            away_win: match.away_win,
            over_25: match.over_25 || null,
            under_25: match.under_25 || null,
            btts_yes: match.btts_yes || null,
            btts_no: match.btts_no || null,
            bookmaker: match.bookmaker || 'flashscore',
            source: 'firecrawl:flashscore',
            scraped_at: new Date().toISOString(),
            match_url: url,
          }
          SCRAPE_CACHE.set(cacheKey, { ts: Date.now(), data: result })
          return result
        }
      }
    }
  } catch (err) {
    console.error(`[FIRECRAWL] Error: ${err.message}`)
  }

  SCRAPE_CACHE.set(cacheKey, { ts: Date.now(), data: null })
  return null
}

/**
 * Get live scores from Flashscore via Firecrawl.
 * @param {string} league
 * @returns {Promise<Array>}
 */
async function getLiveScores(league) {
  const urls = buildFlashscoreUrls(league)
  if (!urls.live) return []

  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) return []

  try {
    const prompt = 'Extract all live matches with current scores (home_team, away_team, home_score, away_score, minute, status).'
    const data = await extract(urls.live, LIVE_SCORES_SCHEMA, prompt)
    return (data && data.matches) || []
  } catch (err) {
    console.error(`[FIRECRAWL] Live scores error: ${err.message}`)
    return []
  }
}

/**
 * Generic scrape via Firecrawl.
 * @param {string} url
 * @param {object} schema
 * @param {string} prompt
 * @returns {Promise<object|null>}
 */
async function scrapeUrl(url, schema, prompt) {
  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY not set')

  return await extract(url, schema, prompt)
}

function clearCache() {
  SCRAPE_CACHE.clear()
}

function isAvailable() {
  return !!process.env.FIRECRAWL_API_KEY
}

module.exports = {
  getOdds,
  getLiveScores,
  scrapeUrl,
  extract,
  clearCache,
  isAvailable,
  getCacheSize: () => SCRAPE_CACHE.size,
  // Exposed for testing
  _buildFlashscoreUrls: buildFlashscoreUrls,
}
