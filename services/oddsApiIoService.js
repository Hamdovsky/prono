const axios = require('axios')
const logger = require('../core/logger')

const BASE_URL = 'https://api.odds-api.io/v3'

// Bookmakers autorisés par le plan gratuit (2 max). Ces noms doivent être dans
// la sélection du compte (PUT /bookmakers/selected/select).
const DEFAULT_BOOKMAKERS = '1xbet,22Bet'

const SETTLED = new Set(['settled', 'cancelled'])

function isPending(status) {
  return !status || !SETTLED.has(status)
}

function pickBest(bookmakers) {
  let best = { home: 0, draw: 0, away: 0 }
  for (const bmName of Object.keys(bookmakers || {})) {
    const markets = bookmakers[bmName]
    if (!Array.isArray(markets)) continue
    const ml = markets.find((m) => String(m.name).toUpperCase() === 'ML')
    if (!ml || !ml.odds || !ml.odds[0]) continue
    const o = ml.odds[0]
    const h = parseFloat(o.home)
    const d = parseFloat(o.draw)
    const a = parseFloat(o.away)
    if (!h || !a) continue
    best = {
      home: h > best.home ? h : best.home,
      draw: d > best.draw ? d : best.draw,
      away: a > best.away ? a : best.away,
    }
  }
  return best.home && best.away ? best : null
}

const NEGATIVE_TTL_MS = 2 * 60 * 60 * 1000

class OddsApiIoService {
  constructor() {
    this.apiKey = process.env.ODDSAPI_IO_KEY || ''
    this.enabled = process.env.ODDSAPI_IO_ENABLED !== 'false'
    this._quotaExhaustedUntil = 0
    this._searchCache = new Map()
    // Negative cache: matches we have already queried but found no bookmaker
    // odds for. Remembered for 2h (TTL) so the hourly cron does not waste
    // the tiny free-tier quota re-pinging the exact same matches every cycle.
    this._notFound = new Map()

    if (!this.apiKey) {
      logger.warn('[OddsAPI.io] ODDSAPI_IO_KEY manquant — désactivé')
    } else if (!this.enabled) {
      logger.warn('[OddsAPI.io] Service désactivé (ODDSAPI_IO_ENABLED=false)')
    } else {
      logger.info(`[OddsAPI.io] Service prêt — clé: ${this.apiKey.slice(0, 8)}...`)
    }
  }

  isAvailable() {
    if (!this.enabled) return false
    if (!this.apiKey) return false
    // Opportunistic cache pruning (cheap, called at each batch start) to keep
    // the 512Mi free dyno from OOM-ing on retained JSON.
    this._pruneCaches()
    if (this._quotaExhaustedUntil) {
      if (Date.now() < this._quotaExhaustedUntil) return false
      this._quotaExhaustedUntil = 0
      logger.info('[OddsAPI.io] Rate limit window passed — service resumed')
    }
    return true
  }

  _pruneCaches(maxCache = 80) {
    try {
      const now = Date.now()
      if (this._searchCache.size > maxCache) {
        let overflow = this._searchCache.size - maxCache
        for (const key of this._searchCache.keys()) {
          if (overflow <= 0) break
          this._searchCache.delete(key)
          overflow--
        }
      }
      if (this._notFound.size > 200) {
        const oldest = this._notFound.keys().next().value
        this._notFound.delete(oldest)
      }
    } catch (_) {}
  }

  async _get(endpoint) {
    if (!this.isAvailable()) return null
    try {
      const { data } = await axios.get(
        `${BASE_URL}${endpoint}${endpoint.includes('?') ? '&' : '?'}apiKey=${this.apiKey}`,
        { timeout: 15000 }
      )
      return data
    } catch (err) {
      const status = err.response?.status
      if (status === 429) {
        const reset = err.response?.headers?.['x-ratelimit-reset']
        const resetMs = reset ? new Date(reset).getTime() : Date.now() + 60 * 60 * 1000
        this._quotaExhaustedUntil = resetMs
        logger.warn(`[OddsAPI.io] Rate limit hit — paused until ${new Date(resetMs).toISOString()}`)
      } else if (status === 403) {
        logger.warn(`[OddsAPI.io] Accès refusé (plan): ${err.response?.data?.error || ''}`)
      } else {
        logger.error(`[OddsAPI.io] Error ${status}: ${err.message}`)
      }
      return null
    }
  }

  async searchEvents(query) {
    const now = Date.now()
    const cached = this._searchCache.get(query)
    if (cached && now - cached.ts < 30 * 60 * 1000) {
      return cached.data
    }
    const data = await this._get(`/events/search?query=${encodeURIComponent(query)}`)
    const results = Array.isArray(data) ? data : []
    this._searchCache.set(query, { ts: now, data: results })
    // Caps memory (512Mi free dyno): limit search cache and prune expired entries.
    if (this._searchCache.size > 80) {
      const oldest = this._searchCache.keys().next().value
      this._searchCache.delete(oldest)
    }
    return results
  }

  // Cotes 1X2 (market ML) pour une liste d'event ids (≤10 par appel).
  async getOddsMulti(eventIds, bookmakers = DEFAULT_BOOKMAKERS) {
    if (!Array.isArray(eventIds) || !eventIds.length) return []
    const out = []
    for (let i = 0; i < eventIds.length; i += 10) {
      const chunk = eventIds.slice(i, i + 10)
      const data = await this._get(
        `/odds/multi?eventIds=${chunk.join(',')}&bookmakers=${bookmakers}&markets=ML`
      )
      if (Array.isArray(data)) out.push(...data)
    }
    return out
  }

  // Normaliseur d'équipe (contrat homeTeam/awayTeam du backfill).
  normalizeTeam(name) {
    if (!name || typeof name !== 'string') return ''
    let s = name.toLowerCase().trim()
    try {
      s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    } catch (_) {}
    s = s
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const suffixes = [
      ' fc',
      ' f.c.',
      ' sc',
      ' ac',
      ' afc',
      ' us',
      ' as',
      ' cf',
      ' united',
      ' city',
      ' town',
      ' athletic',
      ' sporting',
      ' real',
      ' racing',
      ' club',
      ' b',
      ' ii',
      ' iii',
      ' u23',
      ' u21',
      ' u20',
      ' u19',
      ' reserves',
      ' reserve',
      ' youth',
      ' academy',
    ]
    for (const suf of suffixes) {
      if (s.endsWith(suf)) {
        s = s.slice(0, -suf.length).trim()
        break
      }
    }
    return s
  }

  isNotFound(matchId, ttlMs = NEGATIVE_TTL_MS) {
    if (!matchId) return false
    const e = this._notFound.get(matchId)
    if (!e) return false
    if (Date.now() - e >= ttlMs) {
      this._notFound.delete(matchId)
      return false
    }
    return true
  }

  markNotFound(matchId) {
    if (matchId) this._notFound.set(matchId, Date.now())
  }

  clearNotFound(matchId) {
    if (matchId) this._notFound.delete(matchId)
  }

  // Cherche l'event OddsAPI pour un match (par noms) — renvoie uniquement l'id.
  // Utilise le cache searchEvents (30 min) ; ne consomme PAS de quota odds.
  async getEventId(match) {
    if (!match || !match.homeTeam || !match.awayTeam) return null
    const hn = this.normalizeTeam(match.homeTeam)
    const an = this.normalizeTeam(match.awayTeam)
    if (!hn || !an) return null
    for (const term of [`${hn} ${an}`, `${an} ${hn}`, match.awayTeam, match.homeTeam]) {
      const results = (await this.searchEvents(term)).filter((e) => isPending(e.status))
      if (!results.length) continue
      const event =
        results.find((e) => {
          const eh = this.normalizeTeam(e.home)
          const ea = this.normalizeTeam(e.away)
          return (eh === hn && ea === an) || (eh === an && ea === hn)
        }) ||
        results.find(
          (e) => this.normalizeTeam(e.home).includes(hn) && this.normalizeTeam(e.away).includes(an)
        )
      if (event) return event.id
    }
    return null
  }

  // Cherche l'event OddsAPI pour un match (par noms), puis renvoie les cotes ML.
  async fetchOddsForMatch(match) {
    if (!match || !match.homeTeam || !match.awayTeam) return null
    if (!this.isAvailable()) return null
    // Skip matches already proven to have no bookmaker odds this TTL window.
    if (this.isNotFound(match.id)) return null

    const hn = this.normalizeTeam(match.homeTeam)
    const an = this.normalizeTeam(match.awayTeam)
    if (!hn || !an) return null

    let eventId = null
    // 1) Recherche combinée "home away" (1 appel réseau nominal) — réduit la consommation du quota.
    for (const term of [`${hn} ${an}`, `${an} ${hn}`, match.awayTeam, match.homeTeam]) {
      const results = (await this.searchEvents(term)).filter((e) => isPending(e.status))
      if (!results.length) continue
      const event =
        results.find((e) => {
          const eh = this.normalizeTeam(e.home)
          const ea = this.normalizeTeam(e.away)
          return (eh === hn && ea === an) || (eh === an && ea === hn)
        }) ||
        results.find(
          (e) => this.normalizeTeam(e.home).includes(hn) && this.normalizeTeam(e.away).includes(an)
        )
      if (event) {
        eventId = event.id
        break
      }
    }

    if (!eventId) {
      this.markNotFound(match.id)
      return null
    }
    const odds = await this.getOddsMulti([eventId])
    const ev = odds[0]
    if (!ev || !ev.bookmakers) {
      this.markNotFound(match.id)
      return null
    }
    const best = pickBest(ev.bookmakers)
    if (!best) this.markNotFound(match.id)
    return best
  }

  // Contest groupé pour le backfill (core/oddsBackfill).
  async fetchEventsWithOdds(_dateStr) {
    if (!this.isAvailable()) return []
    const popular = [
      'arsenal',
      'liverpool',
      'manchester',
      'barcelona',
      'real madrid',
      'bayern',
      'psg',
    ]
    const seen = new Map()
    for (const term of popular) {
      const results = (await this.searchEvents(term)).filter((e) => isPending(e.status))
      if (!results.length) continue
      const ids = results.slice(0, 10).map((e) => e.id)
      const odds = await this.getOddsMulti(ids)
      const byId = new Map(odds.map((o) => [String(o.id), o]))
      for (const e of results.slice(0, 10)) {
        const ev = byId.get(String(e.id))
        const ml = ev && ev.bookmakers ? pickBest(ev.bookmakers) : null
        if (!ml) continue
        const k = `${this.normalizeTeam(e.home)}|${this.normalizeTeam(e.away)}`
        if (!seen.has(k)) {
          seen.set(k, {
            homeTeam: e.home,
            awayTeam: e.away,
            odds_home: ml.home,
            odds_draw: ml.draw,
            odds_away: ml.away,
            source: 'oddsapiio',
          })
        }
      }
    }
    return Array.from(seen.values())
  }

  async getUpcomingFixtures() {
    const all = []
    for (const term of ['liverpool', 'barcelona', 'real madrid', 'bayern', 'psg']) {
      all.push(...(await this.searchEvents(term)).filter((e) => isPending(e.status)))
    }
    return all
  }
}

module.exports = new OddsApiIoService()
