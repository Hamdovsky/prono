const axios = require('axios')
const logger = require('../core/logger')

const BASE_URL = 'https://api.odds-api.io/v3'

class OddsApiIoService {
  constructor() {
    this.apiKey = process.env.ODDSAPI_IO_KEY || ''
    this.enabled = process.env.ODDSAPI_IO_ENABLED !== 'false'
    this._quotaExhausted = false

    if (!this.apiKey) {
      logger.warn('[OddsAPI.io] ODDSAPI_IO_KEY manquant — désactivé')
    } else if (!this.enabled) {
      logger.warn('[OddsAPI.io] Service désactivé (ODDSAPI_IO_ENABLED=false)')
    } else {
      logger.info(`[OddsAPI.io] Service prêt — clé: ${this.apiKey.slice(0, 8)}...`)
    }
  }

  isAvailable() {
    if (!this.enabled) return false
    if (!this.apiKey) return false
    if (this._quotaExhausted) return false
    return true
  }

  async _fetch(endpoint) {
    if (!this.isAvailable()) return null
    if (this._quotaExhausted) return null

    try {
      const { data } = await axios.get(`${BASE_URL}${endpoint}${endpoint.includes('?') ? '&' : '?'}apiKey=${this.apiKey}`, {
        timeout: 10000
      })
      return data
    } catch (err) {
      const status = err.response?.status
      if (status === 429) {
        this._quotaExhausted = true
        logger.warn('[OddsAPI.io] Rate limit hit (100 req/h)')
      } else {
        logger.error(`[OddsAPI.io] Error ${status}: ${err.message}`)
      }
      return null
    }
  }

  async getEvents(sport = 'football', status = 'live', limit = 50) {
    const data = await this._fetch(`/events?sport=${sport}&limit=${limit}`)
    return Array.isArray(data) ? data : []
  }

  async getOdds(eventId) {
    const data = await this._fetch(`/odds?eventId=${eventId}`)
    return data || null
  }

  async getBookmakers() {
    const data = await this._fetch('/bookmakers?sport=football')
    return Array.isArray(data) ? data : []
  }

  async getUpcomingFixtures() {
    const all = await this.getEvents('football', 'upcoming', 50)
    const now = new Date()
    const twoDays = new Date(now.getTime() + 2 * 86400000)
    return all.filter(e => {
      const d = new Date(e.date)
      return d > now && d < twoDays
    })
  }
}

module.exports = new OddsApiIoService()
