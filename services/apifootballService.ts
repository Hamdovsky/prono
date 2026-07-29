// @ts-nocheck
import axios from 'axios'
import logger from '../core/logger'

class ApiFootballService {
  constructor() {
    this.apiKey = process.env.APIFOOTBALL_KEY || ''
    this.baseUrl = 'https://v3.football.api-sports.io'
    this.enabled = process.env.APIFOOTBALL_ENABLED !== 'false'
    this._authFailed = false
    this._quotaExhausted = false

    if (!this.apiKey || this.apiKey.startsWith('CHANGER_MOI')) {
      logger.warn('⚠️ [APIFOOTBALL] No API key configured — service disabled')
      this.enabled = false
    } else {
      logger.info(`✅ [APIFOOTBALL] Service ready (key: ${this.apiKey.slice(0, 8)}...)`)
    }
  }

  isAvailable() {
    return this.enabled && !!this.apiKey && !this._authFailed && !this._quotaExhausted
  }

  getQuotaStatus() {
    return {
      available: this.isAvailable(),
      authFailed: this._authFailed,
      quotaExhausted: this._quotaExhausted,
    }
  }

  async _fetch(endpoint) {
    if (!this.isAvailable()) return null
    try {
      const url = `${this.baseUrl}${endpoint}`
      const { data } = await axios.get(url, {
        headers: { 'x-apisports-key': this.apiKey },
        timeout: 15000,
      })
      return data
    } catch (e) {
      const status = e.response?.status
      if (status === 401 || status === 403) {
        this._authFailed = true
        logger.error('❌ [APIFOOTBALL] Auth failed')
      } else if (status === 429) {
        this._quotaExhausted = true
        logger.warn('🛑 [APIFOOTBALL] Rate limit exceeded')
      } else logger.warn(`⚠️ [APIFOOTBALL] Request failed: ${e.message}`)
      return null
    }
  }

  async fetchLeagues() {
    const data = await this._fetch('/leagues')
    return data?.response || []
  }

  async fetchFixtures(params = {}) {
    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join('&')
    const data = await this._fetch(`/fixtures${query ? '?' + query : ''}`)
    return data?.response || []
  }

  async fetchFixturesByDate(date) {
    return this.fetchFixtures({ date, timezone: 'Europe/Paris' })
  }

  async fetchOdds(fixtureId) {
    const data = await this._fetch(`/odds?fixture=${fixtureId}`)
    if (!data?.response?.length) return null
    const bookmaker = data.response[0]?.bookmakers?.[0]
    if (!bookmaker?.bets?.length) return null
    const matchWinner = bookmaker.bets.find((b) => b.name === 'Match Winner')
    if (!matchWinner?.values?.length) return null
    const home = matchWinner.values.find((v) => v.value === 'Home')
    const draw = matchWinner.values.find((v) => v.value === 'Draw')
    const away = matchWinner.values.find((v) => v.value === 'Away')
    return {
      home: parseFloat(home?.odd) || null,
      draw: parseFloat(draw?.odd) || null,
      away: parseFloat(away?.odd) || null,
    }
  }

  async fetchPredictions(fixtureId) {
    const data = await this._fetch(`/predictions?fixture=${fixtureId}`)
    return data?.response || []
  }

  async fetchEvents(dateStr) {
    const fixtures = await this.fetchFixturesByDate(dateStr)
    return (fixtures || []).map((f) => this.mapToMatch(f))
  }

  mapToMatch(fixture) {
    const home = fixture.teams?.home || {}
    const away = fixture.teams?.away || {}
    const league = fixture.league || {}
    const goals = fixture.goals || {}
    const score = fixture.score || {}

    return {
      id: `af_${fixture.fixture?.id || Date.now()}`,
      homeTeam: home.name || 'Home',
      awayTeam: away.name || 'Away',
      league: league.name || 'Unknown',
      category_name: league.country || '',
      tournament_name: league.name || '',
      tournament_id: league.id || null,
      home_team_id: home.id || null,
      away_team_id: away.id || null,
      startTimestamp: fixture.fixture?.timestamp || Math.floor(Date.now() / 1000),
      timestamp: fixture.fixture?.date || new Date().toISOString(),
      status:
        fixture.fixture?.status?.short === 'FT'
          ? 'finished'
          : fixture.fixture?.status?.short === 'LIVE'
            ? 'inprogress'
            : 'scheduled',
      confidence: 50,
      prediction: null,
      verdict: 'PENDING',
      odds_home: null,
      odds_draw: null,
      odds_away: null,
      score_home: goals.home ?? null,
      score_away: goals.away ?? null,
      last_updated: Date.now(),
      insufficient_data: 1,
      source: 'apifootball',
      fullData: JSON.stringify({
        fixtureId: fixture.fixture?.id,
        home: home.name,
        away: away.name,
        league: league.name,
        startTimestamp: fixture.fixture?.timestamp,
      }),
    }
  }
}

export = new ApiFootballService()
