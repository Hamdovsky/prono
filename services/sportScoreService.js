const axios = require('axios')
const logger = require('../core/logger')

class SportScoreService {
  constructor() {
    this.baseUrl = 'https://sportscore.com'
    this.enabled = process.env.SPORTSCORE_ENABLED !== 'false'
    this._lastError = null

    logger.info('[SPORTSCORE] Service prêt — gratuit, sans clé, 10k req/jour')
  }

  isAvailable() {
    return this.enabled
  }

  async fetchLiveEvents() {
    if (!this.enabled) return []

    try {
      const { data } = await axios.get(`${this.baseUrl}/api/widget/matches/`, {
        params: { sport: 'football', limit: 50 },
        timeout: 10000
      })

      if (!data?.matches?.length) return []

      return data.matches
        .filter(m => m.status === 'inprogress' || m.status === 'live')
        .map(m => ({
          source: 'sportscore',
          id: `ss_${m.home}_${m.away}`.replace(/\s+/g, '_').toLowerCase(),
          homeTeam: m.home,
          awayTeam: m.away,
          league: m.competition || 'Unknown',
          scoreHome: m.home_score ?? 0,
          scoreAway: m.away_score ?? 0,
          minute: m.time_elapsed || '0',
          status: 'live',
          homeWinP: 33,
          drawP: 34,
          awayWinP: 33
        }))
    } catch (err) {
      this._lastError = err.message
      logger.warn(`[SPORTSCORE] Erreur: ${err.message}`)
      return []
    }
  }
}

module.exports = new SportScoreService()
