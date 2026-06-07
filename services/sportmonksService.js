const axios = require('axios')
const logger = require('../core/logger')

class SportmonksService {
  constructor() {
    this.apiKey = process.env.SPORTMONKS_KEY || ''
    this.baseUrl = 'https://api.sportmonks.com/v3/football'
    this.enabled = process.env.SPORTMONKS_ENABLED !== 'false'
    this._authFailed = false
    this._quotaExhausted = false

    if (!this.apiKey || this.apiKey.startsWith('CHANGER_MOI')) {
      logger.warn('⚠️ [SPORTMONKS] No API key configured — service disabled')
      this.enabled = false
    } else {
      logger.info(`✅ [SPORTMONKS] Service ready (key: ${this.apiKey.slice(0, 8)}...)`)
    }
  }

  isAvailable() {
    return this.enabled && !!this.apiKey && !this._authFailed && !this._quotaExhausted
  }

  getQuotaStatus() {
    return {
      available: this.isAvailable(),
      authFailed: this._authFailed,
      quotaExhausted: this._quotaExhausted
    }
  }

  async fetchEvents(dateStr) {
    const fixtures = await this.fetchUpcomingFixtures()
    return (fixtures || []).map(f => this.mapToMatch(f))
  }

  async _fetch(endpoint) {
    if (!this.isAvailable()) return null
    try {
      const sep = endpoint.includes('?') ? '&' : '?'
      const url = `${this.baseUrl}${endpoint}${sep}api_token=${this.apiKey}`
      const { data } = await axios.get(url, { timeout: 15000 })
      return data
    } catch (e) {
      const status = e.response?.status
      if (status === 401) { this._authFailed = true; logger.error('❌ [SPORTMONKS] Auth failed (401)') }
      else if (status === 429) { this._quotaExhausted = true; logger.warn('🛑 [SPORTMONKS] Rate limit exceeded') }
      else logger.warn(`⚠️ [SPORTMONKS] Request failed: ${e.message}`)
      return null
    }
  }

  async fetchUpcomingFixtures() {
    const data = await this._fetch('/fixtures/between/2025-01-01/2030-12-31?include=participants;odds&filters=upcoming')
    return data?.data || []
  }

  async fetchFixturesByDateRange(from, to) {
    const data = await this._fetch(`/fixtures/between/${from}/${to}?include=participants;odds`)
    return data?.data || []
  }

  async fetchFixtureById(id) {
    const data = await this._fetch(`/fixtures/${id}?include=participants;odds`)
    return data?.data || null
  }

  async fetchPrematchOdds(fixtureId) {
    const data = await this._fetch(`/odds/pre-match/fixture/${fixtureId}?include=bookmaker;market`)
    return data?.data || []
  }

  mapToMatch(fixture) {
    const participants = fixture.participants || []
    const home = participants.find(p => p.meta?.position === 'home') || {}
    const away = participants.find(p => p.meta?.position === 'away') || {}
    const flatOdds = {}
    if (fixture.odds) {
      const oddsArr = Array.isArray(fixture.odds) ? fixture.odds : [fixture.odds]
      oddsArr.forEach(o => {
        if (o?.market?.name === '3 Way Result') {
          o.outcomes?.forEach(out => {
            if (out.label === 'Home') flatOdds.home_win = out.odds
            if (out.label === 'Draw') flatOdds.draw = out.odds
            if (out.label === 'Away') flatOdds.away_win = out.odds
          })
        }
      })
    }

    return {
      id: `sm_${fixture.id}`,
      homeTeam: home.name || fixture.name?.split(' vs ')[0] || 'Home',
      awayTeam: away.name || fixture.name?.split(' vs ')[1] || 'Away',
      league: fixture.league?.name || fixture.leagueName || 'Unknown',
      startTimestamp: fixture.starting_at
        ? Math.floor(new Date(fixture.starting_at).getTime() / 1000)
        : Math.floor(Date.now() / 1000),
      timestamp: fixture.starting_at || fixture.date || new Date().toISOString(),
      status: fixture.state?.id === 1 ? 'scheduled' : fixture.state?.id === 2 ? 'inprogress' : fixture.state?.id === 3 ? 'finished' : 'scheduled',
      odds_home: flatOdds.home_win || null,
      odds_draw: flatOdds.draw || null,
      odds_away: flatOdds.away_win || null,
      confidence: 50,
      prediction: null,
      verdict: 'PENDING',
      last_updated: Date.now(),
      insufficient_data: 1,
      source: 'sportmonks',
      fullData: JSON.stringify({ fixtureId: fixture.id })
    }
  }
}

module.exports = new SportmonksService()
