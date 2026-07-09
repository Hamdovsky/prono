const axios = require('axios')
const logger = require('../core/logger')

class TheRundownService {
  constructor() {
    this.apiKey = process.env.THERUNDOWN_KEY || ''
    this.baseUrl = 'https://therundown.io/api/v2'
    this.enabled = process.env.THERUNDOWN_ENABLED !== 'false'
    this._quotaExhausted = false
    this._authFailed = false

    if (!this.apiKey || this.apiKey.startsWith('CHANGER_MOI')) {
      logger.warn('⚠️ [THERUNDOWN] No API key configured — service disabled')
      this.enabled = false
    } else {
      logger.info(`✅ [THERUNDOWN] Service ready (key: ${this.apiKey.slice(0, 8)}...)`)
    }

    this.sportIds = {
      soccer: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 33]
    }
    this.soccerNames = ['MLS', 'EPL', 'FRA1', 'GER1', 'ESP1', 'ITA1', 'UEFACHAMP', 'UEFAEURO', 'FIFA', 'JPN1', 'UEFA Europa League']
  }

  isAvailable() {
    return this.enabled && !this._authFailed && !this._quotaExhausted
  }

  _headers() {
    return {
      'X-TheRundown-Key': this.apiKey,
      'Accept': 'application/json'
    }
  }

  async _fetch(endpoint) {
    if (!this.isAvailable()) return null

    try {
      const { data } = await axios.get(`${this.baseUrl}${endpoint}`, {
        headers: this._headers(),
        timeout: 15000
      })
      return data
    } catch (e) {
      const status = e.response?.status
      if (status === 401) {
        this._authFailed = true
        logger.error('❌ [THERUNDOWN] Auth failed (401) — check API key')
      } else if (status === 429) {
        this._quotaExhausted = true
        logger.warn('🛑 [THERUNDOWN] Rate limit exceeded — cooling down')
      } else if (status === 403) {
        logger.warn('⛔ [THERUNDOWN] Access denied (403)')
      } else {
        logger.warn(`⚠️ [THERUNDOWN] Request failed: ${e.message}`)
      }
      return null
    }
  }

  getQuotaStatus() {
    return {
      available: this.isAvailable(),
      authFailed: this._authFailed,
      quotaExhausted: this._quotaExhausted
    }
  }

  async fetchAllSports() {
    const data = await this._fetch('/sports')
    const sports = data?.sports || []
    return sports.map(s => ({
      id: s.sport_id,
      name: s.sport_name,
      isSoccer: this.soccerNames.includes(s.sport_name)
    }))
  }

  async fetchEventsByDate(dateStr, sportId = 10) {
    const data = await this._fetch(`/sports/${sportId}/events/${dateStr}`)
    return data?.events || []
  }

  async fetchEventDetails(eventId) {
    const data = await this._fetch(`/events/${eventId}`)
    return data?.event || null
  }

  async fetchSoccerEvents(dateStr) {
    const allEvents = []
    const ids = this.sportIds.soccer
    for (let i = 0; i < ids.length; i++) {
      const events = await this.fetchEventsByDate(dateStr, ids[i])
      if (events && events.length > 0) {
        for (const e of events) {
          e._sportName = this.soccerNames[i] || `sport_${ids[i]}`
        }
        allEvents.push(...events)
      }
      if (i < ids.length - 1) await new Promise(r => setTimeout(r, 1100))
    }
    return allEvents
  }

  _americanToDecimal(american) {
    if (!american || american === 0) return null
    if (american > 0) return 1 + american / 100
    return 1 + 100 / Math.abs(american)
  }

  _bestPrice(participant) {
    let best = null
    const lines = participant.lines || []
    for (const line of lines) {
      const prices = line.prices || {}
      for (const sbId of Object.keys(prices)) {
        const price = prices[sbId]?.price
        if (price) {
          const dec = this._americanToDecimal(price)
          if (dec && (!best || dec > best)) best = dec
        }
      }
    }
    return best
  }

  async fetchOddsForMatch(eventId) {
    const event = await this.fetchEventDetails(eventId)
    if (!event || !event.markets) return null

    const home = (event.teams || []).find(t => t.is_home) || (event.teams || [])[0]
    const away = (event.teams || []).find(t => t.is_away) || (event.teams || [])[1]
    const homeName = home?.name || ''
    const awayName = away?.name || ''

    const odds = { home: null, draw: null, away: null }
    for (const market of event.markets) {
      if (market.market_id === 1) {
        for (const p of market.participants || []) {
          const pn = (p.name || '').toLowerCase()
          if (pn === homeName.toLowerCase() || p.type === 'TYPE_TEAM' && !pn.includes(awayName.toLowerCase())) {
            odds.home = this._bestPrice(p)
          } else if (pn === awayName.toLowerCase()) {
            odds.away = this._bestPrice(p)
          } else if (p.type === 'TYPE_RESULT' || pn === 'draw') {
            odds.draw = this._bestPrice(p)
          }
        }
      }
    }
    return odds
  }

  mapEventToMatch(event) {
    const teams = event.teams || []
    const home = teams.find(t => t.is_home) || teams[0]
    const away = teams.find(t => t.is_away) || teams[1]
    const eventId = event.event_id
    const ts = event.event_date ? Math.floor(new Date(event.event_date).getTime() / 1000) : Math.floor(Date.now() / 1000)

    let status = 'scheduled'
    const scoreStatus = event.score?.event_status || ''
    if (scoreStatus === 'STATUS_FULL_TIME') status = 'finished'
    else if (scoreStatus === 'STATUS_IN_PROGRESS') status = 'inprogress'

    const odds = { home: null, draw: null, away: null }
    for (const market of event.markets || []) {
      if (market.market_id === 1) {
        for (const p of market.participants || []) {
          const pn = (p.name || '').toLowerCase()
          if (p.type === 'TYPE_RESULT' || pn === 'draw') odds.draw = this._bestPrice(p)
          else if (p.type === 'TYPE_TEAM' && p.id === home?.team_id) odds.home = this._bestPrice(p)
          else if (p.type === 'TYPE_TEAM' && p.id === away?.team_id) odds.away = this._bestPrice(p)
          else if (p.type === 'TYPE_TEAM' && pn === (home?.name || '').toLowerCase()) odds.home = this._bestPrice(p)
          else if (p.type === 'TYPE_TEAM' && pn === (away?.name || '').toLowerCase()) odds.away = this._bestPrice(p)
        }
      }
    }

    return {
      id: `tr_${eventId}`,
      homeTeam: home?.name || 'Home',
      awayTeam: away?.name || 'Away',
      league: this.soccerNames[this.sportIds.soccer.indexOf(event.sport_id)] || `Sport_${event.sport_id}`,
      startTimestamp: ts,
      timestamp: new Date(ts * 1000).toISOString(),
      status,
      odds_home: odds.home,
      odds_draw: odds.draw,
      odds_away: odds.away,
      confidence: 50,
      prediction: null,
      verdict: 'PENDING',
      last_updated: Date.now(),
      insufficient_data: 1,
      category_name: event._sportName || event.sport_name || 'Soccer',
      tournament_name: this.soccerNames[this.sportIds.soccer.indexOf(event.sport_id)] || `Sport_${event.sport_id}`,
      home_team_id: home?.team_id || null,
      away_team_id: away?.team_id || null,
      source: 'therundown',
      fullData: JSON.stringify({ eventId, teams: teams.map(t => ({ id: t.team_id, name: t.name })) })
    }
  }
}

module.exports = new TheRundownService()
