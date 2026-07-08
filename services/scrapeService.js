/**
 * scrapeService.js — AI-powered self-healing scraper service
 * 
 * Architecture:
 *   Tier 0: ScraperAPI (free with API key, residential IPs)
 *            Routes any URL through anti-blocking proxy
 *   Tier 1: Jina AI Reader (free, no key) → markdown → regex extraction
 *            Works for: static HTML pages, Soccerway, text-based odds
 *   Tier 2: Firecrawl (paid, FIRECRAWL_API_KEY) → full JS extraction
 *            Works for: any page (JS-rendered odds, dynamic content)
 *   Tier 3: Legacy cloudscraper (via Python bridge, always available)
 *            Works for: BetExplorer (data-odd attributes)
 *   
 * Usage:
 *   const scrape = require('./scrapeService')
 *   const odds = await scrape.getOdds('Team A', 'Team B', 'League')
 *   const scores = await scrape.getLiveScores('Premier League')
 *   const result = await scrape.scrapeUrl('https://...') // raw markdown
 */

const https = require('https')
const http = require('http')
const { spawn } = require('child_process')
const path = require('path')
const scraperProxy = require('./scraperProxy')

const SCRAPE_CACHE = new Map()
const CACHE_TTL = 15 * 60 * 1000

const BASE_DIR = path.resolve(__dirname, '..')

// ── Utility ──────────────────────────────────────────────────────

function fetchUrl(targetUrl, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl)
    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.get(targetUrl, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
  })
}

// ── Tier 1: Jina AI Reader ──────────────────────────────────────
// Free tier: ~20 req/min, no API key needed.
async function scrapeViaJina(targetUrl) {
  const jinaUrl = `https://r.jina.ai/${targetUrl}`
  const res = await fetchUrl(jinaUrl, 30000)
  if (res.status !== 200) throw new Error(`Jina returned ${res.status}`)
  return res.data
}

// ── Tier 2: Firecrawl ───────────────────────────────────────────
async function scrapeViaFirecrawl(targetUrl, schema) {
  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY not set')

  const body = JSON.stringify({
    url: targetUrl,
    formats: ['extract'],
    extract: {
      schema: schema || ODDS_SCHEMA,
      prompt: 'Extract all match betting odds (1X2, Over/Under 2.5, BTTS) '
            + 'as decimal numbers from this page.',
    },
  })

  return new Promise((resolve, reject) => {
    const parsed = new URL('https://api.firecrawl.dev/v1/scrape')
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      timeout: 45000,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (json.success && json.data && json.data.extract) {
            resolve(json.data.extract)
          } else {
            reject(new Error(json.error || 'Firecrawl extraction failed'))
          }
        } catch (e) {
          reject(new Error('Firecrawl parse error: ' + e.message))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Firecrawl timeout')) })
    req.write(body)
    req.end()
  })
}

// ── Tier 3: Python cloudscraper bridge ──────────────────────────
// Calls the existing oddsFusionEngine.py directly
async function scrapeViaPython(home, away, league) {
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3'
  return new Promise((resolve, reject) => {
    const escapedBase = BASE_DIR.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedHome = home.replace(/'/g, "\\'")
    const escapedAway = away.replace(/'/g, "\\'")
    const escapedLeague = league.replace(/'/g, "\\'")
    const script = `
import sys, json
sys.path.insert(0, r'${escapedBase}/services')
sys.stdout.reconfigure(encoding='utf-8')
from oddsFusionEngine import OddsFusionEngine
engine = OddsFusionEngine()
try:
    o = engine.get_odds('''${escapedHome}''', '''${escapedAway}''', '''${escapedLeague}''', prefer_real=True, use_soccerapi=False)
    print(json.dumps(o))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`
    const proc = spawn(pythonBin, ['-c', script], {
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = '', stderr = ''
    proc.stdout.on('data', d => stdout += d)
    proc.stderr.on('data', d => stderr += d)
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(stderr))
      try {
        const result = JSON.parse(stdout.trim().split('\n').slice(-1)[0])
        if (result.error) return reject(new Error(result.error))
        resolve(result)
      } catch (e) {
        reject(new Error('Parse error: ' + e.message + ' | stdout: ' + stdout))
      }
    })
    proc.on('error', reject)
  })
}

// ── Odds extraction from markdown ──────────────────────────────
function extractOddsFromMarkdown(markdown, homeHint, awayHint) {
  const lines = markdown.split('\n')
  const results = []
  let currentMatch = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // Detect match row
    const matchPattern = line.match(/^(.+?)\s+(?:vs|VS|v\.|–|-)\s+(.+?)$/)
    if (matchPattern && !line.match(/^\d+\.\d+/)) {
      if (currentMatch) results.push(currentMatch)
      currentMatch = {
        home_team: matchPattern[1].trim(),
        away_team: matchPattern[2].trim(),
        home_win: null, draw: null, away_win: null,
        over_25: null, under_25: null,
        btts_yes: null, btts_no: null,
      }
      continue
    }

    if (!currentMatch) continue

    // Detect decimal odds pattern
    const oddsMatch = line.match(/(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)/)
    if (oddsMatch) {
      const nums = [parseFloat(oddsMatch[1]), parseFloat(oddsMatch[2]), parseFloat(oddsMatch[3])]
      if (nums.every(n => n >= 1.01 && n <= 20)) {
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

    // Detect "O/U" or "Over/Under" line
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
  if (currentMatch) results.push(currentMatch)

  // Filter by team hints
  if (homeHint || awayHint) {
    const hh = (homeHint || '').toLowerCase()
    const ah = (awayHint || '').toLowerCase()
    return results.filter(m => {
      const hm = m.home_team.toLowerCase()
      const am = m.away_team.toLowerCase()
      return (!hh || hm.includes(hh) || hh.includes(hm)) &&
             (!ah || am.includes(ah) || ah.includes(am))
    })
  }

  return results
}

// ── Source registry ─────────────────────────────────────────────
const LEAGUE_SLUGS = {
  'usl championship': '/football/usa/usl-championship/fixtures/',
  'veikkausliiga': '/football/finland/veikkausliiga/fixtures/',
  'brasileirão serie b': '/football/brazil/serie-b/fixtures/',
  'segunda división': '/football/spain/segunda-division/fixtures/',
  'botola pro': '/football/morocco/botola/fixtures/',
  'premier league': '/football/england/premier-league/fixtures/',
  'serie a': '/football/italy/serie-a/fixtures/',
  'la liga': '/football/spain/laliga/fixtures/',
  'ligue 1': '/football/france/ligue-1/fixtures/',
  'bundesliga': '/football/germany/bundesliga/fixtures/',
  'mls': '/football/usa/mls/fixtures/',
  'world cup 2026': '/football/international/world-cup/fixtures/',
}

function getBetExplorerUrl(league) {
  const key = Object.keys(LEAGUE_SLUGS).find(k => league.toLowerCase().includes(k))
  return key ? `https://www.betexplorer.com${LEAGUE_SLUGS[key]}` : null
}

function getSoccerwayUrl(league) {
  const l = league.toLowerCase()
  if (l.includes('world cup')) return 'https://www.soccerway.com/world/world-championship/fixtures/'
  if (l.includes('premier')) return 'https://www.soccerway.com/england/premier-league/fixtures/'
  if (l.includes('la liga')) return 'https://www.soccerway.com/spain/laliga/fixtures/'
  if (l.includes('serie a')) return 'https://www.soccerway.com/italy/serie-a/fixtures/'
  if (l.includes('ligue 1')) return 'https://www.soccerway.com/france/ligue-1/fixtures/'
  if (l.includes('bundesliga')) return 'https://www.soccerway.com/germany/bundesliga/fixtures/'
  if (l.includes('mls')) return 'https://www.soccerway.com/usa/mls/fixtures/'
  return null
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Main entry: get odds for a match.
 * Fallback chain: Python (cloudscraper) → Jina Reader → Firecrawl
 */
async function getOdds(homeTeam, awayTeam, league) {
  const cacheKey = `${homeTeam}|${awayTeam}|${league}`

  // Check cache
  const cached = SCRAPE_CACHE.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL && cached.data) {
    return cached.data
  }

  // 0. Try ScraperAPI (residential IPs, bypasses blocking)
  if (scraperProxy.isAvailable()) {
    const betexplorerUrl = getBetExplorerUrl(league)
    const soccerwayUrl = getSoccerwayUrl(league)
    for (const targetUrl of [betexplorerUrl, soccerwayUrl].filter(Boolean)) {
      try {
        const html = await scraperProxy.fetchText(targetUrl, { render: false, timeout: 25000 })
        const matches = extractOddsFromMarkdown(html, homeTeam, awayTeam)
        if (matches.length > 0 && matches[0].home_win) {
          const m = matches[0]
          const result = {
            home_win: m.home_win, draw: m.draw, away_win: m.away_win,
            over_25: m.over_25, under_25: m.under_25,
            btts_yes: m.btts_yes, btts_no: m.btts_no,
            source: 'scraperapi:betexplorer',
            scraped_at: new Date().toISOString(),
            match_url: targetUrl,
          }
          SCRAPE_CACHE.set(cacheKey, { ts: Date.now(), data: result })
          return result
        }
      } catch (e) {
        // ScraperAPI tier failed for this URL, try next
      }
    }
  }

  // 1. Try Python cloudscraper (works for BetExplorer)
  try {
    const result = await scrapeViaPython(homeTeam, awayTeam, league)
    if (result && result.home_win && result.draw && result.away_win) {
      result.source = (result.source || 'python') + ':cloudscraper'
      result.scraped_at = new Date().toISOString()
      SCRAPE_CACHE.set(cacheKey, { ts: Date.now(), data: result })
      return result
    }
  } catch (e) {
    // Python fallback failed, continue
  }

  // 2. Try Jina Reader (free, for pages with visible text odds)
  const betexplorerUrl = getBetExplorerUrl(league)
  const soccerwayUrl = getSoccerwayUrl(league)

  for (const targetUrl of [betexplorerUrl, soccerwayUrl].filter(Boolean)) {
    try {
      const markdown = await scrapeViaJina(targetUrl)
      const matches = extractOddsFromMarkdown(markdown, homeTeam, awayTeam)
      if (matches.length > 0 && matches[0].home_win) {
        const m = matches[0]
        const result = {
          home_win: m.home_win, draw: m.draw, away_win: m.away_win,
          over_25: m.over_25, under_25: m.under_25,
          btts_yes: m.btts_yes, btts_no: m.btts_no,
          source: 'jina:reader',
          scraped_at: new Date().toISOString(),
          match_url: targetUrl,
        }
        SCRAPE_CACHE.set(cacheKey, { ts: Date.now(), data: result })
        return result
      }
    } catch (e) {
      // Jina failed, continue
    }
  }

  // 3. Try Firecrawl (requires FIRECRAWL_API_KEY)
  if (process.env.FIRECRAWL_API_KEY && betexplorerUrl) {
    try {
      const fcResult = await scrapeViaFirecrawl(betexplorerUrl)
      if (fcResult && fcResult.home_win) {
        const result = {
          ...fcResult,
          source: 'firecrawl',
          scraped_at: new Date().toISOString(),
          match_url: betexplorerUrl,
        }
        SCRAPE_CACHE.set(cacheKey, { ts: Date.now(), data: result })
        return result
      }
    } catch (e) {
      // Firecrawl failed
    }
  }

  return null
}

/**
 * Get live scores via Jina Reader (Soccerway/Flashscore).
 */
async function getLiveScores(league) {
  const url = getSoccerwayUrl(league)
  if (!url) return []

  try {
    const markdown = await scrapeViaJina(url.replace('/fixtures/', '/results/'))
    const lines = markdown.split('\n')
    const matches = []

    for (let i = 0; i < lines.length; i++) {
      // Format: "Team A 3 - 1 Team B"
      const scoreLine = lines[i].match(/^(.+?)\s+(\d+)\s*[–-]\s*(\d+)\s+(.+)$/)
      if (scoreLine) {
        matches.push({
          home_team: scoreLine[1].trim(),
          home_score: parseInt(scoreLine[2]),
          away_score: parseInt(scoreLine[3]),
          away_team: scoreLine[4].trim(),
          status: 'live',
        })
      }
    }

    return matches
  } catch (e) {
    return []
  }
}

/**
 * Scrape any URL and return structured data.
 */
async function scrapeUrl(targetUrl, schema) {
  const cacheKey = `url:${targetUrl}`
  const cached = SCRAPE_CACHE.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data

  let result = null

  // Jina (free)
  try {
    const md = await scrapeViaJina(targetUrl)
    result = { markdown: md, source: 'jina', url: targetUrl }
  } catch (e) {
    // fall through
  }

  // Firecrawl (paid)
  if (!result && process.env.FIRECRAWL_API_KEY) {
    try {
      result = await scrapeViaFirecrawl(targetUrl, schema)
      result.source = 'firecrawl'
      result.url = targetUrl
    } catch (e) {
      // fall through
    }
  }

  if (result) {
    SCRAPE_CACHE.set(cacheKey, { ts: Date.now(), data: result })
  }
  return result
}

function clearCache() {
  SCRAPE_CACHE.clear()
}

module.exports = {
  getCacheSize: () => SCRAPE_CACHE.size,
  getOdds,
  getLiveScores,
  scrapeUrl,
  clearCache,
  _scrapeViaJina: scrapeViaJina,
  _scrapeViaFirecrawl: scrapeViaFirecrawl,
  _extractOddsFromMarkdown: extractOddsFromMarkdown,
  _fetchUrl: fetchUrl,
}
