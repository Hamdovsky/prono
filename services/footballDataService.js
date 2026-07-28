const axios = require('axios')
const database = require('../core/database')
const logger = require('../core/logger')
const enrichedPredictions = require('../core/enriched_predictions')
const { createQuotaManager } = require('./sourceQuotaManager')

class FootballDataService {
  constructor() {
    this.apiKey = process.env.FOOTBALLDATA_KEY || ''
    this.host = process.env.FOOTBALLDATA_HOST || 'api.football-data.org'
    this.baseUrl =
      this.host === 'api.football-data.org'
        ? `https://${this.host}/v4`
        : `https://${this.host}/api/v1`
    this.quota = createQuotaManager('footballdata')
  }

  // ── INTERNAL FETCH ──────────────────────────────────────────────────────

  async _fetch(endpoint, dateStr) {
    if (!this.apiKey) {
      logger.warn('[FOOTBALLDATA] FOOTBALLDATA_KEY is missing.')
      return []
    }

    try {
      let url = `${this.baseUrl}${endpoint}`
      const headers = { Accept: 'application/json' }
      if (this.host === 'api.football-data.org') {
        headers['X-Auth-Token'] = this.apiKey
        if (dateStr) {
          url = `${this.baseUrl}/matches?dateFrom=${dateStr}&dateTo=${dateStr}`
        }
      } else {
        headers['Authorization'] = `Bearer ${this.apiKey}`
      }
      logger.info(`📡 [FOOTBALLDATA] GET ${url}`)
      const { data } = await axios.get(url, {
        headers,
        timeout: 15000,
      })
      // Handle both { fixtures: [] } and { data: { fixtures: [] } }
      const root = data?.data || data
      return root?.matches || root?.fixtures || []
    } catch (e) {
      logger.error(`❌ [FOOTBALLDATA] Request failed (${endpoint}): ${e.message}`)
      return []
    }
  }

  // ── PUBLIC API ──────────────────────────────────────────────────────────

  isAvailable() {
    return !!this.apiKey && process.env.FOOTBALLDATA_ENABLED !== 'false'
  }

  async fetchOdds(match) {
    return null
  }

  /**
   * Fetches today's fixtures from FootballData.io
   */
  async fetchTodayFixtures() {
    if (process.env.FOOTBALLDATA_ENABLED !== 'true') {
      logger.warn('⚠️ [FOOTBALLDATA] Service is disabled in .env')
      return []
    }
    const today = new Date().toISOString().split('T')[0]
    const fixtures = await this._fetch('/fixtures/today', today)
    logger.info(`✅ [FOOTBALLDATA] Today: ${fixtures.length} fixtures`)
    return fixtures
  }

  /**
   * Fetches upcoming (tomorrow + next few days) fixtures
   */
  async fetchUpcomingFixtures() {
    if (process.env.FOOTBALLDATA_ENABLED !== 'true') {
      logger.warn('⚠️ [FOOTBALLDATA] Service is disabled in .env')
      return []
    }
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const fixtures = await this._fetch('/fixtures/upcoming', tomorrow.toISOString().split('T')[0])
    logger.info(`✅ [FOOTBALLDATA] Upcoming: ${fixtures.length} fixtures`)
    return fixtures
  }

  /**
   * Fetches fixtures for a specific date (YYYY-MM-DD)
   */
  async fetchFixturesByDate(dateStr) {
    if (process.env.FOOTBALLDATA_ENABLED !== 'true') return []
    const fixtures = await this._fetch(`/matches/date/${dateStr}`, dateStr)
    logger.info(`✅ [FOOTBALLDATA] ${dateStr}: ${fixtures.length} fixtures`)
    return fixtures
  }

  // ── MAP FD fixture → DB schema ──────────────────────────────────────────

  _parseTeam(t) {
    if (!t) return ''
    if (typeof t === 'string') return t
    return t.name || t.team_name || ''
  }

  _parseLeague(l) {
    if (!l) return null
    if (typeof l === 'string') return l
    return l.name || l.competition_name || null
  }

  _mapFixture(f) {
    const matchId = f.match_id || f.id || `fd_${Date.now()}_${Math.random()}`
    const ts =
      f.date_unix ||
      f.timestamp ||
      (f.utcDate ? Math.floor(new Date(f.utcDate).getTime() / 1000) : Math.floor(Date.now() / 1000))
    let timestamp = new Date().toISOString()
    try {
      const d = new Date(ts * 1000)
      if (!isNaN(d.getTime())) timestamp = d.toISOString()
    } catch (_) {}

    const rawStatus = (f.status || '').toLowerCase()
    let status = 'scheduled'
    if (rawStatus === 'complete' || rawStatus === 'ft' || rawStatus === 'finished')
      status = 'finished'
    else if (rawStatus === 'live' || rawStatus === 'inprogress' || rawStatus === 'in_play')
      status = 'inprogress'

    const competition = f.competition || f.league || {}
    const leagueName = this._parseLeague(competition) || 'Unknown'

    return {
      id: `fd_${matchId}`,
      homeTeam: this._parseTeam(f.homeTeam || f.home_team) || 'Home',
      awayTeam: this._parseTeam(f.awayTeam || f.away_team) || 'Away',
      league: leagueName,
      category_name: competition.area?.name || competition.country || '',
      tournament_name: leagueName,
      tournament_id: competition.id || competition.competition_id || null,
      season_id: f.season?.id || f.season_id || null,
      home_team_id: (f.homeTeam || f.home_team)?.id || null,
      away_team_id: (f.awayTeam || f.away_team)?.id || null,
      startTimestamp: ts,
      timestamp,
      status,
      confidence: 50,
      prediction: null,
      verdict: 'PENDING',
      odds_home: f.odds?.home_win || null,
      odds_draw: f.odds?.draw || null,
      odds_away: f.odds?.away_win || null,
      home_xg: f.xg?.home || 1.1,
      away_xg: f.xg?.away || 1.0,
      last_updated: Date.now(),
      insufficient_data: 0,
      source: 'footballdata',
      fullData: JSON.stringify({
        homeTeam: this._parseTeam(f.homeTeam || f.home_team),
        awayTeam: this._parseTeam(f.awayTeam || f.away_team),
        league: leagueName,
        startTimestamp: ts,
        status,
      }),
    }
  }

  // ── PIPELINE ────────────────────────────────────────────────────────────

  /**
   * Full fallback pipeline: fetch today + upcoming, insert, enrich
   */
  async processFallbackFixtures() {
    try {
      const quotaStatus = this.quota.getQuotaStatus()
      if (!quotaStatus.isActive || quotaStatus.remaining <= 0) {
        logger.warn(
          `[FOOTBALLDATA] Daily quota exhausted (${quotaStatus.used}/${quotaStatus.limit}).`
        )
        return 0
      }

      const todayFixtures = await this.fetchTodayFixtures()
      const upcomingFixtures = await this.fetchUpcomingFixtures()

      // Deduplicate by match_id
      const seen = new Set()
      let allFixtures = [...todayFixtures, ...upcomingFixtures].filter((f) => {
        const fid = String(f.match_id || f.id || '')
        if (seen.has(fid)) return false
        seen.add(fid)
        return true
      })

      allFixtures = allFixtures.filter((f) => this.quota.canProcessMatch(f.match_id || f.id))
      allFixtures = allFixtures.slice(0, quotaStatus.remaining)

      if (allFixtures.length === 0) return 0

      let count = 0
      for (const f of allFixtures) {
        try {
          const match = this._mapFixture(f)

          // Normalize team names via registry
          try {
            match.homeTeam = await database.resolveTeamName(match.homeTeam)
            match.awayTeam = await database.resolveTeamName(match.awayTeam)
          } catch (_) {}

          // Insert raw match
          await database.insertMatch(match)
          this.quota.registerMatch(f.match_id || f.id || match.id)

          // Perform Quant Poisson prediction & Kelly financials
          const enriched = await enrichedPredictions.fastEnrichMatch(match)
          await database.updatePredictions(enriched.id, enriched)

          count++
        } catch (matchErr) {
          logger.error(
            `❌ [FOOTBALLDATA] Error processing match ${f.match_id}: ${matchErr.message}`
          )
        }
      }

      logger.info(`✅ [FOOTBALLDATA] Fallback pipeline complete: ${count} matches processed.`)
      return count
    } catch (e) {
      logger.error(`❌ [FOOTBALLDATA] Fallback pipeline failed: ${e.message}`)
      return 0
    }
  }
}

module.exports = new FootballDataService()
