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
/**
 * Extract the list of { name, value } choices from a `/event/{id}/odds/{marketId}/featured`
 * payload, whatever nesting the payload uses (featured.default, featured.fullTime,
 * featured.markets, or a flat featured object).
 */
function parseMarketChoices(data) {
  if (!data || !data.featured) return null
  const featured = data.featured
  const market =
    featured.default ||
    featured.fullTime ||
    (Array.isArray(featured.markets) ? featured.markets[0] : null) ||
    Object.values(featured)[0]
  if (!market) return null
  let choices = market.choices
  if (!Array.isArray(choices) && Array.isArray(market.markets)) {
    const inner = market.markets.find((mk) => Array.isArray(mk.choices))
    if (inner) choices = inner.choices
  }
  if (!Array.isArray(choices)) return null
  return choices
    .map((choice) => {
      const name = String(choice.name || '')
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
      return val && val > 1 ? { name, value: val } : null
    })
    .filter(Boolean)
}

function parseFeaturedOdds(data) {
  const choices = parseMarketChoices(data)
  if (!choices) return null

  const odds = {}
  for (const choice of choices) {
    const name = String(choice.name || '').toLowerCase()
    if (name === '1' || name === 'home') odds.home = choice.value
    else if (name === 'x' || name === 'draw') odds.draw = choice.value
    else if (name === '2' || name === 'away') odds.away = choice.value
  }

  if (odds.home && odds.draw && odds.away) return odds
  if (odds.home && odds.away) return odds
  return null
}

/**
 * Extract the Over/Under 2.5 odds from a `/event/{id}/odds/5/featured` payload.
 * Choices are usually named "Over 2.5" / "Under 2.5" (or "2.5+"/"2.5-").
 */
function parseOverUnder25(data) {
  const choices = parseMarketChoices(data)
  if (!choices) return null
  const result = {}
  for (const choice of choices) {
    const name = String(choice.name || '').toLowerCase()
    if (!name.includes('2.5')) continue
    const isOver =
      /(^|[\s-])(over|o)\b/i.test(name) || /\bover\b/i.test(name) || /2\.5\s*\+/.test(name)
    const isUnder =
      /(^|[\s-])(under|u)\b/i.test(name) || /\bunder\b/i.test(name) || /2\.5\s*-/.test(name)
    if (isOver) result.over25 = choice.value
    else if (isUnder) result.under25 = choice.value
  }
  return result.over25 && result.under25 ? result : null
}

/**
 * Extract the BTTS odds from a `/event/{id}/odds/6/featured` payload.
 * Choices are named "Yes" / "No".
 */
function parseBtts(data) {
  const choices = parseMarketChoices(data)
  if (!choices) return null
  const result = {}
  for (const choice of choices) {
    const name = String(choice.name || '').toLowerCase()
    if (/(^|[\s-])yes$|\byes\b/.test(name)) result.btts_yes = choice.value
    else if (/(^|[\s-])no$|\bno\b/.test(name)) result.btts_no = choice.value
  }
  return result.btts_yes && result.btts_no ? result : null
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

  _isNotFound(key) {
    const e = this._notFound.get(key)
    if (!e) return false
    if (Date.now() - e >= NOT_FOUND_TTL_MS) {
      this._notFound.delete(key)
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
   * Fetch a single market payload for an event (best-effort). On any failure the
   * event:market pair is remembered in the negative cache for 2h.
   */
  async _fetchMarket(eventId, marketId) {
    const key = `${eventId}:${marketId}`
    if (this._isNotFound(key)) return null
    try {
      const data = await SofaAPI.getOddsFeatured(eventId, marketId)
      if (!data || !data.featured) {
        this._notFound.set(key, Date.now())
        return null
      }
      return data
    } catch (e) {
      this._notFound.set(key, Date.now())
      return null
    }
  }

  /**
   * Fetch real odds for a match from Sofascore (free, no key).
   * 1X2 (market 1), Over/Under 2.5 (market 5) and BTTS (market 6) are fetched in
   * parallel; each market is best-effort. Returns null when nothing was found.
   * Example: { home, draw, away, over25, under25, btts_yes, btts_no }.
   */
  async fetchOddsForMatch(match) {
    if (!this.isAvailable() || !match) return null
    let eventId = this._resolveEventId(match)
    if (!eventId) {
      eventId = await this._resolveEventByTeams(match)
      if (!eventId) return null
    }

    const [m1, m5, m6] = await Promise.all([
      this._fetchMarket(eventId, 1),
      this._fetchMarket(eventId, 5),
      this._fetchMarket(eventId, 6),
    ])

    const odds = {}
    const r1 = m1 ? parseFeaturedOdds(m1) : null
    if (r1) Object.assign(odds, r1)
    const r5 = m5 ? parseOverUnder25(m5) : null
    if (r5) Object.assign(odds, r5)
    const r6 = m6 ? parseBtts(m6) : null
    if (r6) Object.assign(odds, r6)

    if (
      !odds.home &&
      !odds.draw &&
      !odds.away &&
      !odds.over25 &&
      !odds.under25 &&
      !odds.btts_yes &&
      !odds.btts_no
    ) {
      return null
    }
    logger.debug(
      `[SOFASCORE-ODDS] Odds for ${match.homeTeam} vs ${match.awayTeam}: H=${odds.home} D=${odds.draw} A=${odds.away} O/U=${odds.over25}/${odds.under25} BTTS=${odds.btts_yes}/${odds.btts_no}`
    )
    return odds
  }
}

module.exports = new SofascoreOddsService()
module.exports.parseFeaturedOdds = parseFeaturedOdds
module.exports.parseOverUnder25 = parseOverUnder25
module.exports.parseBtts = parseBtts
