const bsdService = require('./bsdService')
const sportScoreService = require('./sportScoreService')
const sportSrcService = require('./sportSrcService')
const database = require('../core/database')
const logger = require('../core/logger')
const socketService = require('./socketService')

class LiveMatchService {
  constructor() {
    this.activeMatches = []
    this.pollInterval = null
    this.lastSource = null
    this._emptyCycles = 0
  }

  async checkPredictionOutcomes() {
    try {
      const unchecked = database.getUncheckedLivePredictions()
      if (!unchecked || unchecked.length === 0) return

      for (const row of unchecked) {
        const match = await database.getMatchById(row.match_id)
        if (match && match.status === 'finished') {
          await database.updateLivePredictionOutcomes(
            row.match_id,
            match.scoreHome || 0,
            match.scoreAway || 0
          )
        }
      }
    } catch (e) {
      // silent
    }
  }

  async syncLive() {
    // Check for finished matches to update training outcomes
    this.checkPredictionOutcomes()

    let matches = []
    let source = null

    // 1) Try BSD
    if (bsdService.isAvailable()) {
      try {
        const events = await bsdService.fetchLiveEvents()
        if (events && events.length > 0) {
          matches = events.map(e => this._mapLiveEvent(e, 'bsd'))
          source = 'BSD'
        }
      } catch (e) {
        logger.warn(`[LIVE] BSD failed: ${e.message}`)
      }
    }

    // 2) Fallback → SportScore (no key needed)
    if (!matches.length && sportScoreService.isAvailable()) {
      try {
        const events = await sportScoreService.fetchLiveEvents()
        if (events && events.length > 0) {
          matches = events
          source = 'SportScore'
        }
      } catch (e) {
        logger.warn(`[LIVE] SportScore failed: ${e.message}`)
      }
    }

    // 3) Fallback → SportSRC (needs key)
    if (!matches.length && sportSrcService.isAvailable()) {
      try {
        const events = await sportSrcService.fetchLiveEvents()
        if (events && events.length > 0) {
          matches = events
          source = 'SportSRC'
        }
      } catch (e) {
        logger.warn(`[LIVE] SportSRC failed: ${e.message}`)
      }
    }

    // Broadcast
    if (matches.length > 0) {
      this.activeMatches = matches
      this.lastSource = source
      this._emptyCycles = 0
      socketService.broadcast('live:update', matches)
      logger.info(`[LIVE] Synced ${matches.length} live matches via ${source}`)
    } else {
      this._emptyCycles++
      if (this.activeMatches.length > 0) {
        this.activeMatches = []
        socketService.broadcast('live:update', [])
      }
      if (this._emptyCycles % 6 === 1) {
        logger.info(`[LIVE] Aucun match live trouvé (${this._emptyCycles} cycles vides)`)
      }
    }
  }

  _mapLiveEvent(event, source) {
    if (source === 'sportscore' || source === 'SportScore' || source === 'sportsrc' || source === 'SportSRC') {
      return {
        id: event.id || `live_${Date.now()}`,
        homeTeam: event.homeTeam || 'Home',
        awayTeam: event.awayTeam || 'Away',
        league: event.league || 'Unknown',
        scoreHome: event.scoreHome ?? 0,
        scoreAway: event.scoreAway ?? 0,
        minute: event.minute || '0',
        status: 'live',
        source: event.source || source.toLowerCase(),
        homeWinP: event.homeWinP ?? 33,
        drawP: event.drawP ?? 34,
        awayWinP: event.awayWinP ?? 33,
        confidence: 0,
        category: 'LIVE',
        staleSecs: 0
      }
    }

    // BSD native event
    return {
      id: event.id || `live_${Date.now()}`,
      homeTeam: event.home_team?.name || event.homeTeam || 'Home',
      awayTeam: event.away_team?.name || event.awayTeam || 'Away',
      league: event.league?.name || event.tournament_name || 'Unknown',
      scoreHome: event.scores?.home ?? event.home_score ?? 0,
      scoreAway: event.scores?.away ?? event.away_score ?? 0,
      minute: event.minute || event.time_elapsed || '0',
      status: 'live',
      source: source || 'bsd',
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
