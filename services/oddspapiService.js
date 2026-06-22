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
    const active = tours
      .filter(t => (t.upcomingFixtures || 0) > 0 || (t.futureFixtures || 0) > 0)
      .sort((a, b) => (b.upcomingFixtures + b.futureFixtures) - (a.upcomingFixtures + a.futureFixtures))
      .slice(0, 3)
    const ids = active.map(t => t.tournamentId).filter(Boolean)
    if (ids.length === 0) return []

    // Step 1: fetch raw odds fixtures (bare fixtureIds + odds)
    const oddsFixtures = await this.fetchOddsByTournaments(ids)
    if (!oddsFixtures?.length) return []

    // Step 2: fetch all fixtureIds that need details
    const fixtureIds = oddsFixtures.map(f => f.fixtureId).filter(Boolean)
    const detailsMap = new Map()

    if (fixtureIds.length > 0) {
      const batchSize = 25
      for (let i = 0; i < fixtureIds.length; i += batchSize) {
        const batch = fixtureIds.slice(i, i + batchSize)
        const details = await this._fetch(`/fixtures?fixtureIds=${batch.join(',')}&include=participants,league.country`)
        if (Array.isArray(details)) {
          for (const d of details) {
            if (d.fixtureId) detailsMap.set(d.fixtureId, d)
          }
        }
        await new Promise(r => setTimeout(r, 200))
      }
    }

    // Step 3: merge odds + details, map to matches
    const matches = []
    for (const f of oddsFixtures) {
      if (!f.fixtureId) continue
      const detail = detailsMap.get(f.fixtureId) || {}
      const match = this.mapToMatch({ ...detail, ...f })
      // skip if team names are missing (API returned bare fixture data)
      if (match.homeTeam === 'Home' && match.awayTeam === 'Away') continue
      matches.push(match)
    }

    return matches
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

  async fetchOddsForMatch(match) {
    const fixtureId = match.oddspapi_match_id || match.id?.toString().replace(/^op_/, '') || match.id
    if (!fixtureId) return null
    const raw = await this._fetch(`/odds?fixtureId=${fixtureId}&oddsFormat=decimal`)
    if (!raw) return null
    const data = Array.isArray(raw) ? raw[0] : raw
    const odds = data?.odds || data || {}
    return {
      home: parseFloat(odds.home_win || odds.home || odds[0]) || null,
      draw: parseFloat(odds.draw || odds[1]) || null,
      away: parseFloat(odds.away_win || odds.away || odds[2]) || null,
    }
  }

  _extractParticipant(fixture, index) {
    if (fixture.participants?.[index]?.name) return fixture.participants[index].name
    if (fixture[`participant${index + 1}`]) return fixture[`participant${index + 1}`]
    if (index === 0 && fixture.homeTeam) return fixture.homeTeam
    if (index === 1 && fixture.awayTeam) return fixture.awayTeam
    const participant = fixture.participants?.[index]
    if (participant?.name) return participant.name
    return null
  }

  mapToMatch(fixture) {
    const homeTeam = this._extractParticipant(fixture, 0) || 'Home'
    const awayTeam = this._extractParticipant(fixture, 1) || 'Away'
    const leagueName = fixture.tournamentName || fixture.league?.name || fixture.leagueName || fixture.league || 'Unknown'
    const categoryName = fixture.categoryName || fixture.league?.country?.name || fixture.league?.country || ''

    return {
      id: `op_${fixture.fixtureId}`,
      homeTeam,
      awayTeam,
      league: leagueName,
      category_name: categoryName,
      tournament_name: fixture.tournamentName || leagueName,
      tournament_id: fixture.tournamentId || fixture.league?.id || null,
      home_team_id: fixture.homeTeamId || String(fixture.participants?.[0]?.id || ''),
      away_team_id: fixture.awayTeamId || String(fixture.participants?.[1]?.id || ''),
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
      fullData: JSON.stringify({
        fixtureId: fixture.fixtureId,
        tournamentId: fixture.tournamentId
      })
    }
  }
}

module.exports = new OddsPapiService()
