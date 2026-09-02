/**
 * LiveScoreAggregator — Orchestrateur multi-source pour matchs live.
 *
 * Role: Combine scores live (Livescore) + cotes (BetExplorer/Flashscore/Fotmob)
 * Strategy: Promise.any — prend la première réponse valide de chaque source
 *
 * Score Flow:
 *   Livescore API → Match IDs + scores + minute
 *   BetExplorer → Cotes 1X2, O/U, BTTS (par équipe)
 *
 * Usage:
 *   const agg = require('./LiveScoreAggregator')
 *   const matches = await agg.getLiveMatchesWithOdds()
 */
const LiveScoreScraper = require('./scrapers/LiveScoreScraper')
const BetExplorerScraper = require('./scrapers/ScrapingBypassScraper')

const CACHE_TTL = 20000
let cache = { ts: 0, matches: [] }

async function getMatchOdds(homeTeam, awayTeam, league) {
  const sources = []
  try {
    const be = await BetExplorerScraper.getOdds(homeTeam, awayTeam, league, '', '', null)
    if (be && (be.home_win || be.over_25)) sources.push(be)
  } catch (_) {}
  if (sources.length > 0) return sources[0]
  return null
}

async function enrichWithOdds(matches) {
  const limited = matches.slice(0, 10)
  const promises = limited.map(async (m) => {
    try {
      const odds = await getMatchOdds(m.homeTeam, m.awayTeam, m.league)
      return { ...m, odds: odds || null }
    } catch (_) {
      return { ...m, odds: null }
    }
  })
  return Promise.all(promises)
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
    const enriched = await enrichWithOdds(liveMatches.slice(0, 30))
    cache = { ts: now, matches: enriched }
    return enriched
  } catch (e) {
    console.error('[LiveScoreAggregator] Error:', e.message)
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
    const enriched = await enrichWithOdds(live.slice(0, 15))
    cache = { ts: now, matches: enriched }
    return enriched
  } catch (e) {
    console.error('[LiveScoreAggregator] Error:', e.message)
    return []
  }
}

function clearCache() {
  cache = { ts: 0, matches: [] }
}

module.exports = { getLiveMatchesWithOdds, getAllMatchesWithOdds, clearCache }
