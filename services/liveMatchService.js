const sportScoreService = require('./sportScoreService')
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

  async fetchUpcomingFallback() {
    try {
      // Only source: SportScore (free, no key)
      const axios = require('axios')
      const { data } = await axios.get('https://sportscore.com/api/widget/matches/', {
        params: { sport: 'football', limit: 50 },
        timeout: 8000
      })
      if (data?.matches?.length) {
        return data.matches
          .filter(m => m.status === 'upcoming')
          .slice(0, 30)
          .map(m => ({
            id: `ss_upc_${m.home}_${m.away}`.replace(/\s+/g, '_').toLowerCase(),
            homeTeam: m.home,
            awayTeam: m.away,
            league: m.competition || 'Unknown',
            scoreHome: 0,
            scoreAway: 0,
            minute: '0',
            status: 'scheduled',
            source: 'sportscore',
            isFallback: true,
            homeWinP: 33,
            drawP: 34,
            awayWinP: 33
          }))
      }
    } catch {}
    return []
  }

  async syncLive() {
    // Check for finished matches to update training outcomes
    this.checkPredictionOutcomes()

    let matches = []
    let source = null

    // ONLY source: SportScore (free, no key needed)
    try {
      const events = await sportScoreService.fetchLiveEvents()
      if (events && events.length > 0) {
        matches = events
        source = 'SportScore'
      }
    } catch (e) {
      logger.warn(`[LIVE] SportScore failed: ${e.message}`)
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
      // Show upcoming matches as fallback after 3 empty cycles
      if (this._emptyCycles === 3 || this._emptyCycles % 12 === 3) {
        const fallback = await this.fetchUpcomingFallback()
        if (fallback.length > 0) {
          this.activeMatches = fallback
          this.lastSource = 'fallback-upcoming'
          socketService.broadcast('live:update', fallback)
          logger.info(`[LIVE] Fallback: ${fallback.length} upcoming matches`)
          return
        }
      }
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
    if (source === 'sofascore' || source === 'Sofascore') {
      const desc = event.status?.description || ''
      let minute = 0
      const minMatch = desc.match(/(\d+)/)
      if (minMatch) minute = parseInt(minMatch[1])
      if (desc.includes('Halftime') || desc.includes('HT')) minute = 45
      return {
        id: event.id || `live_${Date.now()}`,
        homeTeam: event.homeTeam?.name || 'Home',
        awayTeam: event.awayTeam?.name || 'Away',
        league: event.tournament?.name || 'Unknown',
        scoreHome: event.homeScore?.display ?? event.homeScore?.current ?? 0,
        scoreAway: event.awayScore?.display ?? event.awayScore?.current ?? 0,
        minute: minute || '0',
        status: 'live',
        source: 'sofascore',
        homeWinP: 33,
        drawP: 34,
        awayWinP: 33,
        confidence: 0,
        category: 'LIVE',
        staleSecs: 0,
        possession: event.statistics?.possession,
        redCards: event.statistics?.redCards,
        liveData: {
          minute,
          homeScore: event.homeScore?.display ?? event.homeScore?.current ?? 0,
          awayScore: event.awayScore?.display ?? event.awayScore?.current ?? 0,
          possession: event.statistics?.possession,
          redCards: event.statistics?.redCards
        }
      }
    }

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
