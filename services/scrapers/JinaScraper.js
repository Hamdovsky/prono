/**
 * JinaScraper.js — Cost-effective fallback scraper (zero-auth, free)
 *
 * Uses Jina AI Reader (r.jina.ai) to convert URLs → clean markdown.
 * No API key needed. Rate limit: ~20 req/min free tier.
 *
 * Target: Soccerway (static HTML), WorldFootball.net, static odds pages.
 *
 * Strategy:
 *   - Fetch URL via r.jina.ai proxy → markdown
 *   - Pattern-match odds from markdown tables
 *   - Returns structured odds data
 */

const https = require('https')
const http = require('http')

const SCRAPE_CACHE = new Map()
const CACHE_TTL = 15 * 60 * 1000

// ── HTTP utility ─────────────────────────────────────────────────

function fetchUrl(targetUrl, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl)
    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.get(
      targetUrl,
      {
        timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }))
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Timeout'))
    })
  })
}

// ── URL builders ─────────────────────────────────────────────────

function buildSoccerwayUrls(league) {
  const l = league.toLowerCase()
  const slugs = {
    'world cup': 'world/world-championship',
    'premier league': 'england/premier-league',
    'la liga': 'spain/laliga',
    'serie a': 'italy/serie-a',
    'ligue 1': 'france/ligue-1',
    bundesliga: 'germany/bundesliga',
    mls: 'usa/mls',
    'usl championship': 'usa/usl-championship',
    'brasileirão serie a': 'brazil/serie-a',
    'brasileirão serie b': 'brazil/serie-b',
    eredivisie: 'netherlands/eredivisie',
  }
  const slug = slugs[Object.keys(slugs).find((k) => l.includes(k))]
  if (!slug) return { fixtures: null, results: null }
  return {
    fixtures: `https://www.soccerway.com/${slug}/fixtures/`,
    results: `https://www.soccerway.com/${slug}/results/`,
  }
}

// ── Odds extraction from markdown ──────────────────────────────

function extractOddsFromMarkdown(markdown, homeHint, awayHint) {
  const lines = markdown.split('\n')
  const results = []
  let currentMatch = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    // Detect match row: "Team A vs Team B" or "Team A - Team B"
    const matchPattern = line.match(/^(.+?)\s+(?:vs|VS|v\.|–|-)\s+(.+?)$/)
    if (matchPattern && !line.match(/^\d+\.\d+/)) {
      if (currentMatch && currentMatch.home_win !== null) {
        results.push(currentMatch)
      }
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

    // Detect 1X2 odds: "2.10  3.40  3.80" or similar
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

    // Detect "O/U" line
    const ouPattern = line.match(/(?:Over|O\/U|Under)[:\s]+(\d+\.\d+)\s+(\d+\.\d+)/i)
    if (ouPattern && currentMatch.over_25 === null) {
      currentMatch.over_25 = parseFloat(ouPattern[1])
      currentMatch.under_25 = parseFloat(ouPattern[2])
    }

    // Detect "BTTS" line
    const bttsPattern = line.match(/(?:BTTS|Both)[:\s]+(\d+\.\d+)\s+(\d+\.\d+)/i)
    if (bttsPattern && currentMatch.btts_yes === null) {
      currentMatch.btts_yes = parseFloat(bttsPattern[1])
      currentMatch.btts_no = parseFloat(bttsPattern[2])
    }
  }
  if (currentMatch && currentMatch.home_win !== null) {
    results.push(currentMatch)
  }

  // Filter by team hints
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

// ── Core: Jina fetch ──────────────────────────────────────────

async function fetchViaJina(targetUrl) {
  const jinaUrl = `https://r.jina.ai/${targetUrl}`
  const res = await fetchUrl(jinaUrl, 30000)
  if (res.status !== 200) {
    throw new Error(`Jina returned HTTP ${res.status}`)
  }
  return res.data
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Get odds from Soccerway via Jina AI Reader.
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @param {string} league
 * @returns {Promise<object|null>}
 */
async function getOdds(homeTeam, awayTeam, league) {
  const cacheKey = `jina:${homeTeam}|${awayTeam}|${league}`
  const cached = SCRAPE_CACHE.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data

  const urls = buildSoccerwayUrls(league)
  if (!urls.fixtures) return null

  for (const url of [urls.fixtures, urls.results].filter(Boolean)) {
    try {
      const markdown = await fetchViaJina(url)
      const matches = extractOddsFromMarkdown(markdown, homeTeam, awayTeam)

      if (matches.length > 0 && matches[0].home_win) {
        const m = matches[0]
        const result = {
          home_win: m.home_win,
          draw: m.draw,
          away_win: m.away_win,
          over_25: m.over_25,
          under_25: m.under_25,
          btts_yes: m.btts_yes,
          btts_no: m.btts_no,
          source: 'jina:soccerway',
          scraped_at: new Date().toISOString(),
          match_url: url,
        }
        SCRAPE_CACHE.set(cacheKey, { ts: Date.now(), data: result })
        return result
      }
    } catch (err) {
      // Jina failed for this URL, try next
      continue
    }
  }

  SCRAPE_CACHE.set(cacheKey, { ts: Date.now(), data: null })
  return null
}

/**
 * Get match results/scores from Soccerway.
 * @param {string} league
 * @returns {Promise<Array>}
 */
async function getResults(league) {
  const urls = buildSoccerwayUrls(league)
  if (!urls.results) return []

  try {
    const markdown = await fetchViaJina(urls.results)
    const lines = markdown.split('\n')
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
  } catch (err) {
    return []
  }
}

/**
 * Scrape any URL via Jina.
 * @param {string} targetUrl
 * @returns {Promise<string|null>} Markdown content
 */
async function scrapeUrl(targetUrl) {
  try {
    return await fetchViaJina(targetUrl)
  } catch {
    return null
  }
}

function clearCache() {
  SCRAPE_CACHE.clear()
}

function isAvailable() {
  return true // Always available (free, no auth)
}

module.exports = {
  getOdds,
  getResults,
  scrapeUrl,
  clearCache,
  isAvailable,
  getCacheSize: () => SCRAPE_CACHE.size,
  // Exposed for testing
  _extractOddsFromMarkdown: extractOddsFromMarkdown,
  _fetchViaJina: fetchViaJina,
  _buildSoccerwayUrls: buildSoccerwayUrls,
}
