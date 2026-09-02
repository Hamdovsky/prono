/**
 * LiveScoreAggregator — Orchestrateur multi-source pour matchs live.
 *
 * Role: Combine scores live (Livescore) + cotes (BetExplorer/Flashscore)
 * Strategy:
 *   1. Livescore → matchs live
 *   2. BetExplorer → cotes (priorité 1)
 *   3. FootballData → cotes (fallback, match historique)
 *
 * Stability:
 * - Promise.allSettled pour résultats partiels
 * - Circuit breaker awareness
 * - Cache 30s
 * - Logging structuré
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
const MAX_ODDS_CONCURRENT = 5
const ODDS_DELAY = 300

let cache = { ts: 0, matches: [] }

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

  // Priority 2: FootballData (match historique)
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
    premier: 'E0', championship: 'E1', league one: 'E2', league two: 'E3',
    bundesliga: 'D1', '2. bundesliga': 'D2',
    serie: 'I1', 'serie b': 'I2',
    'la liga': 'SP1', 'segunda': 'SP2',
    'ligue 1': 'F1', 'ligue 2': 'F2',
    eredivisie: 'N1',
    primeira: 'P1',
    'serie a': 'B1', 'brasileirao': 'B1',
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
        console.warn(`[Aggregator] Match ${m.homeTeam} vs ${m.awayTeam} failed: ${result.reason?.message}`)
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
    console.error('[LiveScoreAggregator] getLiveMatchesWithOdds error:', err.message)
    return []
  }
}

async function getAllMatchesWithOdds() {
  const now = Date.now()

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
    console.error('[LiveScoreAggregator] getAllMatchesWithOdds error:', err.message)
    return []
  }
}

function getHealthStatus() {
  return {
    cache: {
      size: cache.matches.length,
      age: Date.now() - cache.ts,
      ttl: CACHE_TTL,
    },
    sources: {
      livescore: LiveScoreScraper.getCacheStats ? LiveScoreScraper.getCacheStats() : null,
      betexplorer: BetExplorerScraper.getCacheStats ? BetExplorerScraper.getCacheStats() : null,
      footballdata: FootballDataScraper.getCacheStats ? FootballDataScraper.getCacheStats() : null,
    },
    circuitBreaker: BetExplorerScraper.getCacheStats ? BetExplorerScraper.getCacheStats().circuitState : 'unknown',
  }
}

function clearCache() {
  cache = { ts: 0, matches: [] }
}

module.exports = {
  getLiveMatchesWithOdds,
  getAllMatchesWithOdds,
  getHealthStatus,
  clearCache,
}
