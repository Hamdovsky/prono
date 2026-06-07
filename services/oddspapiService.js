const axios = require('axios')
const logger = require('../core/logger')

class OddsPapiService {
  constructor() {
    this.apiKey = process.env.ODDSPAPI_KEY || ''
    this.baseUrl = 'https://api.oddspapi.io/v4'
    this.enabled = process.env.ODDSPAPI_ENABLED !== 'false'
    this._authFailed = false
    this._quotaExhausted = false

    if (!this.apiKey || this.apiKey.startsWith('CHANGER_MOI')) {
      logger.warn('⚠️ [ODDSPAPI] No API key configured — service disabled')
      this.enabled = false
    } else {
      logger.info(`✅ [ODDSPAPI] Service ready (key: ${this.apiKey.slice(0, 8)}...)`)
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
    const tours = await this.fetchTournaments(10)
    const ids = tours.slice(0, 5).map(t => t.tournamentId).filter(Boolean)
    if (ids.length === 0) return []
    const fixtures = await this.fetchOddsByTournaments(ids)
    return (fixtures || []).map(f => this.mapToMatch(f))
  }

  async _fetch(endpoint) {
    if (!this.isAvailable()) return null
    try {
      const url = `${this.baseUrl}${endpoint}${endpoint.includes('?') ? '&' : '?'}apiKey=${this.apiKey}`
      const { data } = await axios.get(url, { timeout: 15000 })
      return data
    } catch (e) {
      const status = e.response?.status
      if (status === 401) { this._authFailed = true; logger.error('❌ [ODDSPAPI] Auth failed (401)') }
      else if (status === 429) { this._quotaExhausted = true; logger.warn('🛑 [ODDSPAPI] Rate limit exceeded') }
      else logger.warn(`⚠️ [ODDSPAPI] Request failed: ${e.message}`)
      return null
    }
  }

  async fetchTournaments(sportId = 10) {
    const data = await this._fetch(`/tournaments?sportId=${sportId}`)
    return Array.isArray(data) ? data : []
  }

  async fetchOddsByTournaments(tournamentIds, bookmaker = 'pinnacle') {
    const ids = Array.isArray(tournamentIds) ? tournamentIds.join(',') : tournamentIds
    const data = await this._fetch(`/odds-by-tournaments?bookmaker=${bookmaker}&tournamentIds=${ids}&oddsFormat=decimal`)
    return Array.isArray(data) ? data : []
  }

  async fetchOddsForFixture(fixtureId) {
    return await this._fetch(`/odds?fixtureId=${fixtureId}&oddsFormat=decimal`)
  }

  mapToMatch(fixture) {
    return {
      id: `op_${fixture.fixtureId}`,
      homeTeam: fixture.participant1 || fixture.homeTeam || 'Home',
      awayTeam: fixture.participant2 || fixture.awayTeam || 'Away',
      league: fixture.tournamentName || fixture.league || 'Unknown',
      startTimestamp: fixture.startTime ? Math.floor(new Date(fixture.startTime).getTime() / 1000) : Math.floor(Date.now() / 1000),
      timestamp: fixture.startTime || new Date().toISOString(),
      status: fixture.statusId === 1 ? 'inprogress' : fixture.statusId === 2 ? 'finished' : 'scheduled',
      odds_home: fixture.odds?.home_win || null,
      odds_draw: fixture.odds?.draw || null,
      odds_away: fixture.odds?.away_win || null,
      confidence: 50,
      prediction: null,
      verdict: 'PENDING',
      last_updated: Date.now(),
      insufficient_data: 1,
      source: 'oddspapi',
      fullData: JSON.stringify({ fixtureId: fixture.fixtureId })
    }
  }
}

module.exports = new OddsPapiService()
