const axios = require('axios')
const logger = require('../core/logger')

class ApiNinjasService {
  constructor() {
    this.apiKey = process.env.APININJAS_KEY || ''
    this.baseUrl = 'https://api.api-ninjas.com/v1'
    this.enabled = process.env.APININJAS_ENABLED !== 'false'
    this._lastError = null
    this._quotaExhausted = false

    if (!this.apiKey) {
      logger.warn('🚨 [APININJAS] APININJAS_KEY manquant — service désactivé')
      this.enabled = false
    } else {
      logger.info(
        `✅ [APININJAS] Service prêt — clé: ${this.apiKey.substring(0, 6)}... | 50k req/mois`
      )
    }
  }

  isAvailable() {
    return this.enabled && !!this.apiKey && !this._quotaExhausted
  }

  _headers() {
    return {
      'X-Api-Key': this.apiKey,
      Accept: 'application/json',
    }
  }

  async _fetch(endpoint) {
    if (!this.isAvailable()) return null
    try {
      const { data } = await axios.get(`${this.baseUrl}${endpoint}`, {
        headers: this._headers(),
        timeout: 10000,
      })
      return data
    } catch (e) {
      if (e.response?.status === 429) this._quotaExhausted = true
      if (e.response?.status === 401) logger.warn('🔴 [APININJAS] Clé API invalide')
      this._lastError = e.message
      return null
    }
  }

  async fetchEvents(dateStr) {
    const data = await this._fetch('/football')
    if (!Array.isArray(data)) return []
    return data.map((m) => ({
      source: 'apinjas',
      id: `an_${m.team}_${m.opponent}_${m.year || ''}`,
      homeTeam: m.team || 'Home',
      awayTeam: m.opponent || 'Away',
      league: m.league || m.competition || 'Unknown',
      startTimestamp: m.date ? new Date(m.date).getTime() / 1000 : null,
      status: m.status || 'scheduled',
      scoreHome: m.team_score ?? null,
      scoreAway: m.opponent_score ?? null,
    }))
  }

  async fetchLiveEvents() {
    return []
  }

  async fetchOdds(fixtureId) {
    return null
  }
}

module.exports = new ApiNinjasService()
