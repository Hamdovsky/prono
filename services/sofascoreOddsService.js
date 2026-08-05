const logger = require('../core/logger')
const { SofaAPI, fetchWithRetry, getSofaHeaders } = require('../SofascoreScraping/src/apiClient')

const SOFA_API = 'https://www.sofascore.com/api/v1'
const NOT_FOUND_TTL_MS = 2 * 60 * 60 * 1000

/**
 * Parse the `/event/{id}/odds/1/featured` payload and return the best 1X2
 * (home/draw/away) odds found across the featured market.
 *
 * Response shape (Sofascore):
 *   { featured: { default: { choices: [ { name: '1'|'X'|'2', decimalValue: 1.55 }, ... ] } } }
 * Some providers only expose fractionalValue — both are handled.
 */
function parseFeaturedOdds(data) {
  if (!data || !data.featured) return null
  const featured = data.featured
  const market = featured.default || featured.fullTime || Object.values(featured)[0]
  if (!market || !Array.isArray(market.choices)) return null

  const odds = {}
  for (const choice of market.choices) {
    const name = String(choice.name || '').toLowerCase()
    let val = parseFloat(choice.decimalValue)
    if (!val || val <= 1) {
      const raw = choice.fractionalValue
      if (typeof raw === 'string' && raw.includes('/')) {
        const [n, d] = raw.split('/')
        const num = parseFloat(n)
        const den = parseFloat(d)
        if (num && den) val = num / den + 1
      } else if (raw != null) {
        val = parseFloat(raw)
      }
    }
    if (!val || val <= 1) continue
    if (name === '1' || name === 'home') odds.home = val
    else if (name === 'x' || name === 'draw') odds.draw = val
    else if (name === '2' || name === 'away') odds.away = val
  }

  if (odds.home && odds.draw && odds.away) return odds
  if (odds.home && odds.away) return odds
  return null
}

class SofascoreOddsService {
  constructor() {
    this.enabled = process.env.SOFASCORE_ODDS_ENABLED !== 'false'
    this.disabledByFlag = process.env.DISABLE_SOFASCORE === 'true'
    // Negative cache: event ids already queried without any odds. Remembered
    // for 2h so the hourly/20-min cron does not re-ping the same matches.
    this._notFound = new Map()
    this._eventIdCache = new Map()
    if (this.disabledByFlag) {
      logger.warn('[SOFASCORE-ODDS] Désactivé (DISABLE_SOFASCORE=true)')
    } else if (this.enabled) {
      logger.info('[SOFASCORE-ODDS] Service prêt (source de cotes 100% gratuite, sans clé)')
    } else {
      logger.warn('[SOFASCORE-ODDS] Désactivé (SOFASCORE_ODDS_ENABLED=false)')
    }
  }

  isAvailable() {
    return this.enabled && !this.disabledByFlag
  }

  _isNotFound(eventId) {
    const e = this._notFound.get(eventId)
    if (!e) return false
    if (Date.now() - e >= NOT_FOUND_TTL_MS) {
      this._notFound.delete(eventId)
      return false
    }
    return true
  }

  /**
   * Extract the SofaScore event id from a match object.
   * The Sofascore scraper stores `id = event.id.toString()` directly, so plain
   * numeric ids are already SofaScore event ids. Livescore-prefixed ids need a
   * team-based resolution instead.
   */
  _resolveEventId(match) {
    if (!match) return null
    if (match.sofascore_id) return String(match.sofascore_id)
    if (match._sofaMatchId) return String(match._sofaMatchId)
    try {
      const fd =
        typeof match.fullData === 'string' ? JSON.parse(match.fullData) : match.fullData || {}
      if (fd.sofaMatchId) return String(fd.sofaMatchId)
    } catch (_) {}
    const id = match.id || match.match_id || ''
    if (typeof id === 'string' && id.startsWith('sofascore_')) return id.replace('sofascore_', '')
    if (typeof id === 'string' && id.startsWith('livescore_')) return null
    if (/^\d+$/.test(String(id))) return String(id)
    return null
  }

  async _searchTeamId(name) {
    if (!name) return null
    try {
      const res = await fetchWithRetry(`${SOFA_API}/search/teams?q=${encodeURIComponent(name)}`, {
        headers: getSofaHeaders(),
      })
      if (!res) return null
      const body = await res.json()
      const results = body?.results || []
      if (!results.length) return null
      const exact = results.find(
        (r) => String(r.name || '').toLowerCase() === String(name).toLowerCase()
      )
      return String((exact || results[0]).id)
    } catch (_) {
      return null
    }
  }

  /**
   * Resolve the event id for matches whose stored id is not a SofaScore event id
   * (e.g. `livescore_...`): search both teams by name, then match the upcoming
   * fixture by opponent.
   */
  async _resolveEventByTeams(match) {
    if (!match || !match.homeTeam || !match.awayTeam) return null
    const pairKey = `${String(match.homeTeam).toLowerCase()}|${String(match.awayTeam).toLowerCase()}`
    const cached = this._eventIdCache.get(pairKey)
    if (cached && Date.now() - cached.ts < 60 * 60 * 1000) return cached.id

    const [hId, aId] = await Promise.all([
      this._searchTeamId(match.homeTeam),
      this._searchTeamId(match.awayTeam),
    ])
    if (!hId || !aId) return null
    try {
      const res = await fetchWithRetry(`${SOFA_API}/team/${hId}/events/next/0`, {
        headers: getSofaHeaders(),
      })
      if (!res) return null
      const body = await res.json()
      const events = body?.events || []
      const ev = events.find(
        (e) => String(e.homeTeam?.id) === aId || String(e.awayTeam?.id) === aId
      )
      if (!ev) return null
      this._eventIdCache.set(pairKey, { id: String(ev.id), ts: Date.now() })
      return String(ev.id)
    } catch (_) {
      return null
    }
  }

  /**
   * Fetch real 1X2 odds for a match from Sofascore (free, no key).
   * Returns { home, draw, away } or null when unavailable.
   */
  async fetchOddsForMatch(match) {
    if (!this.isAvailable() || !match) return null
    let eventId = this._resolveEventId(match)
    if (!eventId) {
      eventId = await this._resolveEventByTeams(match)
      if (!eventId) return null
    }
    if (this._isNotFound(eventId)) return null
    try {
      const data = await SofaAPI.getOddsFeatured(eventId)
      const odds = parseFeaturedOdds(data)
      if (odds) {
        logger.debug(
          `[SOFASCORE-ODDS] Odds for ${match.homeTeam} vs ${match.awayTeam}: H=${odds.home} D=${odds.draw} A=${odds.away}`
        )
        return odds
      }
      this._notFound.set(eventId, Date.now())
      return null
    } catch (e) {
      logger.warn(`[SOFASCORE-ODDS] Fetch failed for event ${eventId}: ${e.message}`)
      return null
    }
  }
}

module.exports = new SofascoreOddsService()
module.exports.parseFeaturedOdds = parseFeaturedOdds
