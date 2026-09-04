/**
 * LiveScoreAggregator — Orchestrateur multi-source pour matchs live.
 *
 * Optimisé pour 8GB RAM + réseau non surchargé:
 * - Promise.allSettled pour résultats partiels
 * - Batch concurrency limité (3)
 * - Delay 3s entre batches
 * - Health check avec logging RAM
 *
 * Usage:
 *   const agg = require('./LiveScoreAggregator')
 *   const matches = await agg.getAllMatchesWithOdds()
 */
const LiveScoreScraper = require('./scrapers/LiveScoreScraper')
const BetExplorerScraper = require('./scrapers/ScrapingBypassScraper')
const FootballDataScraper = require('./scrapers/FootballDataScraper')

const CACHE_TTL = 30000
const MAX_LIVE_MATCHES = 20
const MAX_ODDS_CONCURRENT = 3
const ODDS_DELAY = 3000

let cache = { ts: 0, matches: [] }

// ── Toggle Live ON/OFF ────────────────────────────────────────────
// Quand liveEnabled est false, le scraping réseau est désactivé : on renvoie
// le cache existant (sans appel réseau) pour économiser bande passante/RAM
// (8GB). Rétabli par setLiveEnabled(true) ou via l'API.
let liveEnabled = true
let _liveStateFile = null

function stateFile() {
  if (_liveStateFile) return _liveStateFile
  _liveStateFile = require('path').join(__dirname, '..', 'data', 'live_toggle.json')
  return _liveStateFile
}

function loadLiveState() {
  try {
    const fs = require('fs')
    const raw = fs.readFileSync(stateFile(), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.enabled === 'boolean') liveEnabled = parsed.enabled
  } catch {
    /* fichier absent/invalide → défaut true */
  }
}

function saveLiveState() {
  try {
    const fs = require('fs')
    fs.writeFileSync(stateFile(), JSON.stringify({ enabled: liveEnabled, updatedAt: new Date().toISOString() }))
  } catch {
    /* non bloquant */
  }
}

function setLiveEnabled(enabled) {
  liveEnabled = !!enabled
  saveLiveState()
  return liveEnabled
}

function getLiveEnabled() {
  return liveEnabled
}

loadLiveState()

async function getMatchOdds(homeTeam, awayTeam, league) {
  // Priority 1: BetExplorer
  try {
    const be = await BetExplorerScraper.getOdds(homeTeam, awayTeam, league, '', '', null)
    if (be && (be.home_win || be.over_25)) {
      return { odds: be, source: 'betexplorer' }
    }
  } catch (err) {
    console.warn(`[Aggregator] BetExplorer failed for ${homeTeam} vs ${awayTeam}: ${err.message}`)
  }

  // Priority 2: FootballData
  try {
    const leagueCode = findLeagueCode(league)
    if (leagueCode) {
      const fd = await FootballDataScraper.getOddsForMatch(homeTeam, awayTeam, leagueCode)
      if (fd && (fd.home || fd.over25)) {
        return { odds: fd, source: 'footballdata' }
      }
    }
  } catch (err) {
    console.warn(`[Aggregator] FootballData failed for ${homeTeam} vs ${awayTeam}: ${err.message}`)
  }

  return { odds: null, source: null }
}

function findLeagueCode(leagueName) {
  if (!leagueName) return null
  const lower = leagueName.toLowerCase()

  const map = {
    premier: 'E0',
    championship: 'E1',
    bundesliga: 'D1',
    'serie a': 'I1',
    'la liga': 'SP1',
    'ligue 1': 'F1',
    eredivisie: 'N1',
    primeira: 'P1',
    'serie a': 'B1',
    brasileirao: 'B1',
  }

  for (const [key, code] of Object.entries(map)) {
    if (lower.includes(key)) return code
  }
  return null
}

async function enrichWithOdds(matches) {
  const limited = matches.slice(0, MAX_LIVE_MATCHES)
  const results = []
  const totalBatches = Math.ceil(limited.length / MAX_ODDS_CONCURRENT)

  for (let b = 0; b < totalBatches; b++) {
    const start = b * MAX_ODDS_CONCURRENT
    const batch = limited.slice(start, start + MAX_ODDS_CONCURRENT)

    const settled = await Promise.allSettled(
      batch.map(async (m) => {
        const { odds, source } = await getMatchOdds(m.homeTeam, m.awayTeam, m.league)
        return { ...m, odds: odds || null, oddsSource: source }
      })
    )

    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        results.push(result.value)
      } else {
        const m = batch[i]
        console.warn(`[Aggregator] ${m.homeTeam} vs ${m.awayTeam} failed: ${result.reason?.message}`)
        results.push({ ...m, odds: null, oddsSource: null })
      }
    })

    if (b < totalBatches - 1) {
      await new Promise((r) => setTimeout(r, ODDS_DELAY))
    }
  }

  return results
}

async function getLiveMatchesWithOdds() {
  const now = Date.now()

  // Live désactivé → renvoyer le cache existant SANS appeler le réseau.
  if (!liveEnabled) {
    return cache.matches
  }

  if (cache.matches.length > 0 && now - cache.ts < CACHE_TTL) {
    return cache.matches
  }

  try {
    const liveMatches = await LiveScoreScraper.getLiveOnly()

    if (liveMatches.length === 0) {
      cache = { ts: now, matches: [] }
      return []
    }

    const enriched = await enrichWithOdds(liveMatches)
    cache = { ts: now, matches: enriched }
    return enriched

  } catch (err) {
    console.error('[LiveScoreAggregator] Error:', err.message)
    return []
  }
}

async function getAllMatchesWithOdds() {
  const now = Date.now()

  // Live désactivé → renvoyer le cache existant SANS appeler le réseau.
  if (!liveEnabled) {
    return cache.matches
  }

  if (cache.matches.length > 0 && now - cache.ts < CACHE_TTL) {
    return cache.matches
  }

  try {
    const allMatches = await LiveScoreScraper.getLiveMatches()
    const live = allMatches.filter((m) => m.isLive && m.status !== 'finished')

    if (live.length === 0) {
      cache = { ts: now, matches: [] }
      return []
    }

    const enriched = await enrichWithOdds(live)
    cache = { ts: now, matches: enriched }
    return enriched

  } catch (err) {
    console.error('[LiveScoreAggregator] Error:', err.message)
    return []
  }
}

function logHealth() {
  const mem = process.memoryUsage()
  console.log(`[HEALTH] LiveScoreAggregator | RSS: ${Math.round(mem.rss / 1024 / 1024)}MB | Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB | Cache: ${cache.matches.length}`)
  return {
    rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
    cacheSize: cache.matches.length,
  }
}

function getHealthStatus() {
  const mem = process.memoryUsage()
  return {
    memory: {
      rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
    },
    cache: {
      size: cache.matches.length,
      age: cache.ts ? Date.now() - cache.ts : 0,
      ttl: CACHE_TTL,
    },
    sources: {
      livescore: LiveScoreScraper.getCacheStats ? LiveScoreScraper.getCacheStats() : null,
      betexplorer: BetExplorerScraper.getCacheStats ? BetExplorerScraper.getCacheStats() : null,
      footballdata: FootballDataScraper.getCacheStats ? FootballDataScraper.getCacheStats() : null,
    },
  }
}

function clearCache() {
  cache = { ts: 0, matches: [] }
}

module.exports = {
  getLiveMatchesWithOdds,
  getAllMatchesWithOdds,
  getHealthStatus,
  logHealth,
  clearCache,
  setLiveEnabled,
  getLiveEnabled,
}
