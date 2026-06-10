const bsdService = require('./bsdService')
const database = require('../core/database')
const logger = require('../core/logger')
const socketService = require('./socketService')

class LiveMatchService {
  constructor() {
    this.activeMatches = []
    this.pollInterval = null
  }

  async syncLive() {
    try {
      const events = await bsdService.fetchLiveEvents()
      if (!events || events.length === 0) {
        if (this.activeMatches.length > 0) {
          this.activeMatches = []
          socketService.broadcast('live:update', [])
        }
        return
      }

      const matches = events.map(e => this._mapLiveEvent(e))
      this.activeMatches = matches
      socketService.broadcast('live:update', matches)
      logger.info(`[LIVE] Synced ${matches.length} live matches`)
    } catch (err) {
      logger.error(`[LIVE] Sync error: ${err.message}`)
    }
  }

  _mapLiveEvent(event) {
    const homeName = event.home_team?.name || event.homeTeam || 'Home'
    const awayName = event.away_team?.name || event.awayTeam || 'Away'
    return {
      id: event.id || `live_${Date.now()}`,
      homeTeam: homeName,
      awayTeam: awayName,
      league: event.league?.name || event.tournament_name || 'Unknown',
      scoreHome: event.scores?.home ?? event.home_score ?? 0,
      scoreAway: event.scores?.away ?? event.away_score ?? 0,
      minute: event.minute || event.time_elapsed || '0',
      status: 'live',
      homeWinP: event.probabilities?.home ?? 33,
      drawP: event.probabilities?.draw ?? 34,
      awayWinP: event.probabilities?.away ?? 33,
      confidence: 0,
      category: 'LIVE',
      staleSecs: 0
    }
  }

  startPolling(intervalMs = 30000) {
    if (this.pollInterval) clearInterval(this.pollInterval)
    this.syncLive()
    this.pollInterval = setInterval(() => this.syncLive(), intervalMs)
    logger.info(`[LIVE] Polling started every ${intervalMs / 1000}s`)
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }

  getActiveMatches() {
    return this.activeMatches
  }
}

module.exports = new LiveMatchService()
