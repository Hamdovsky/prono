const axios = require('axios')
const database = require('../core/database')
const logger = require('../core/logger')
const enrichedPredictions = require('../core/enriched_predictions')
const { createQuotaManager } = require('./sourceQuotaManager')

class BsdService {
  constructor() {
    this.apiKey = process.env.BSD_API_KEY || ''
    this.baseUrl = process.env.BSD_BASE_URL || 'https://sports.bzzoiro.com/api'
    this.enabled = process.env.BSD_ENABLED !== 'false'
    this.quota = createQuotaManager('bsd')
  }

  isAvailable() {
    return this.enabled && !!this.apiKey
  }

  _headers() {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Accept': 'application/json'
    }
  }

  async _fetch(endpoint) {
    if (!this.isAvailable()) {
      logger.warn('[BSD] Service not available (no API key or disabled)')
      return null
    }

    try {
      logger.info(`[BSD] GET ${endpoint}`)
      const { data } = await axios.get(`${this.baseUrl}${endpoint}`, {
        headers: this._headers(),
        timeout: 15000
      })
      return data
    } catch (err) {
      logger.error(`[BSD] Request failed (${endpoint}): ${err.message}`)
      if (err.response) {
        logger.error(`  Status: ${err.response.status}, Body: ${JSON.stringify(err.response.data).substring(0, 200)}`)
      }
      return null
    }
  }

  // ── PUBLIC API ─────────────────────────────────────────────────

  async fetchEvents(dateStr) {
    const data = await this._fetch(`/events/?date=${dateStr}`)
    return data?.events || data?.data || []
  }

  async fetchPredictions(matchId) {
    return await this._fetch(`/predictions/${matchId}/`)
  }

  async fetchOdds(matchId) {
    return await this._fetch(`/odds/compare/${matchId}/`)
  }

  async fetchUpcomingEvents() {
    const data = await this._fetch('/events/')
    return data?.events || data?.data || []
  }

  // ── MAPPING ─────────────────────────────────────────────────────

  _mapEventToMatch(event) {
    const ts = event.start_timestamp || event.date_unix || Math.floor(new Date(event.date || Date.now()).getTime() / 1000)

    let homeTeam = event.home_team?.name || event.homeTeam || event.home_name || 'Home'
    let awayTeam = event.away_team?.name || event.awayTeam || event.away_name || 'Away'

    if (event.home_team?.name) homeTeam = event.home_team.name
    if (event.away_team?.name) awayTeam = event.away_team.name

    const league = event.league?.name || event.tournament_name || event.competition || 'Unknown'
    const matchId = event.id || event.match_id || `bsd_${ts}_${Math.random().toString(36).substring(2, 8)}`

    return {
      id: `bsd_${matchId}`,
      homeTeam,
      awayTeam,
      league,
      category_name: event.league?.country || event.country || '',
      tournament_name: league,
      tournament_id: event.league?.id || event.tournament_id || null,
      home_team_id: event.home_team?.id || event.home_team_id || null,
      away_team_id: event.away_team?.id || event.away_team_id || null,
      startTimestamp: ts,
      timestamp: new Date(ts * 1000).toISOString(),
      status: event.status || 'scheduled',
      confidence: 50,
      prediction: null,
      verdict: 'PENDING',
      odds_home: event.odds?.home_win || event.odds_home || null,
      odds_draw: event.odds?.draw || event.odds_draw || null,
      odds_away: event.odds?.away_win || event.odds_away || null,
      home_xg: event.xg?.home || event.home_xg || null,
      away_xg: event.xg?.away || event.away_xg || null,
      last_updated: Date.now(),
      insufficient_data: 1,
      source: 'bsd',
      fullData: JSON.stringify({
        id: matchId,
        homeTeam,
        awayTeam,
        league,
        startTimestamp: ts,
        status: event.status || 'scheduled'
      })
    }
  }

  // ── PIPELINE ────────────────────────────────────────────────────

  async syncFixtures(dateStr) {
    if (!this.isAvailable()) return 0

    const events = await this.fetchEvents(dateStr)
    if (!events || events.length === 0) {
      logger.info(`[BSD] No events for ${dateStr}`)
      return 0
    }

    logger.info(`[BSD] ${events.length} events found for ${dateStr}`)
    let count = 0

    for (const event of events) {
      try {
        const match = this._mapEventToMatch(event)

        // Normalize team names
        try {
          match.homeTeam = await database.resolveTeamName(match.homeTeam)
          match.awayTeam = await database.resolveTeamName(match.awayTeam)
        } catch (_) {}

        await database.insertMatch(match)
        count++
      } catch (err) {
        logger.error(`[BSD] Error processing event ${event.id}: ${err.message}`)
      }
    }

    logger.info(`[BSD] Inserted ${count} matches for ${dateStr}`)
    return count
  }

  async enrichMatchOdds(matchId) {
    const oddsData = await this.fetchOdds(matchId.replace(/^bsd_/, ''))
    if (!oddsData) return null

    const bestHome = oddsData.best_odds?.home_win || oddsData.home_win
    const bestDraw = oddsData.best_odds?.draw || oddsData.draw
    const bestAway = oddsData.best_odds?.away_win || oddsData.away_win

    if (bestHome || bestDraw || bestAway) {
      try {
        database.db?.prepare(`
          UPDATE matches SET odds_home = ?, odds_draw = ?, odds_away = ?
          WHERE id = ?
        `).run(bestHome, bestDraw, bestAway, matchId)
      } catch (_) {}
    }

    return { home: bestHome, draw: bestDraw, away: bestAway }
  }

  async fullSync() {
    if (!this.isAvailable()) {
      logger.warn('[BSD] Full sync skipped — service not available')
      return 0
    }

    const today = new Date().toISOString().split('T')[0]
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0]

    let total = 0
    total += await this.syncFixtures(today)
    total += await this.syncFixtures(tomorrow)

    // Enrich inserted matches with odds
    if (total > 0) {
      const db = database.db
      if (db) {
        const matches = db.prepare("SELECT id FROM matches WHERE source = 'bsd' AND status = 'scheduled'").all()
        for (const m of matches) {
          try {
            await this.enrichMatchOdds(m.id)
          } catch (_) {}
        }
      }
    }

    logger.info(`[BSD] Full sync complete: ${total} matches`)
    return total
  }

  async enrichAllMatchesOdds() {
    if (!this.isAvailable()) return 0
    const db = database.db
    if (!db) return 0

    const matches = db.prepare("SELECT id FROM matches WHERE status = 'scheduled'").all()
    logger.info(`[BSD] Enriching ${matches.length} matches with odds...`)
    let count = 0

    for (const m of matches) {
      try {
        const rawId = m.id.replace(/^(bsd_|fd_|rapid_)/, '')
        const oddsData = await this.fetchOdds(rawId)
        if (!oddsData) continue
        const bsdHome = oddsData.best_odds?.home_win || oddsData.home_win || null
        const bsdDraw = oddsData.best_odds?.draw || oddsData.draw || null
        const bsdAway = oddsData.best_odds?.away_win || oddsData.away_win || null
        if (bsdHome || bsdDraw || bsdAway) {
          db.prepare(`
            UPDATE matches SET
              best_odds_home = MAX(COALESCE(best_odds_home, 0), COALESCE(?, 0)),
              best_odds_draw = MAX(COALESCE(best_odds_draw, 0), COALESCE(?, 0)),
              best_odds_away = MAX(COALESCE(best_odds_away, 0), COALESCE(?, 0))
            WHERE id = ?
          `).run(bsdHome || 0, bsdDraw || 0, bsdAway || 0, m.id)
          count++
        }
      } catch (_) {}
    }
    logger.info(`[BSD] Enriched ${count}/${matches.length} matches with better odds`)
    return count
  }
}

module.exports = new BsdService()
