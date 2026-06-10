const axios = require('axios')
const logger = require('../core/logger')

class SportSrcService {
  constructor() {
    this.apiKey = process.env.SPORTSRC_API_KEY || ''
    this.baseUrl = 'https://api.sportsrc.org/v2'
    this.enabled = process.env.SPORTSRC_ENABLED !== 'false' && !!this.apiKey
    this._lastError = null

    if (!this.apiKey) {
      logger.warn('[SPORTSRC] SPORTSRC_API_KEY manquant — service désactivé')
    } else if (this.enabled) {
      logger.info('[SPORTSRC] Service prêt — gratuit 1k req/jour')
    }
  }

  isAvailable() {
    return this.enabled && !!this.apiKey
  }

  async fetchLiveEvents() {
    if (!this.isAvailable()) return []

    try {
      const { data } = await axios.get(`${this.baseUrl}/`, {
        params: {
          type: 'matches',
          sport: 'football',
          status: 'inprogress',
          api_key: this.apiKey
        },
        timeout: 10000
      })

      if (!data?.matches?.length && !data?.data?.length) return []

      const items = data.matches || data.data || []
      return items.map(m => ({
        source: 'sportsrc',
        id: m.id || `src_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        homeTeam: m.home_team?.name || m.home_team || m.homeTeam || 'Home',
        awayTeam: m.away_team?.name || m.away_team || m.awayTeam || 'Away',
        league: m.league?.name || m.competition || m.tournament_name || 'Unknown',
        scoreHome: m.scores?.home ?? m.home_score ?? m.homeScore ?? 0,
        scoreAway: m.scores?.away ?? m.away_score ?? m.awayScore ?? 0,
        minute: m.minute || m.time_elapsed || '0',
        status: 'live',
        homeWinP: 33,
        drawP: 34,
        awayWinP: 33
      }))
    } catch (err) {
      this._lastError = err.message
      logger.warn(`[SPORTSRC] Erreur: ${err.message}`)
      return []
    }
  }
}

module.exports = new SportSrcService()
