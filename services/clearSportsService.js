const axios = require('axios')
const logger = require('../core/logger')

class ClearSportsService {
  constructor() {
    this.apiKey = process.env.CLEARSPORTS_API_KEY || ''
    this.baseUrl = 'https://api.clearsportsapi.com/v1'
    this.enabled = process.env.CLEARSPORTS_ENABLED !== 'false'
    this._lastError = null
    this._quotaExhausted = false

    if (!this.apiKey) {
      logger.warn('🚨 [CLEARSPORTS] CLEARSPORTS_API_KEY manquant — service désactivé')
      this.enabled = false
    } else {
      logger.info(`✅ [CLEARSPORTS] Service prêt — clé: ${this.apiKey.substring(0, 8)}... | 1000 req/mois`)
    }
  }

  isAvailable() {
    return this.enabled && !!this.apiKey && !this._quotaExhausted
  }

  _headers() {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Accept': 'application/json'
    }
  }

  async _fetch(endpoint) {
    if (!this.isAvailable()) return null
    try {
      const { data } = await axios.get(`${this.baseUrl}${endpoint}`, {
        headers: this._headers(),
        timeout: 10000
      })
      return data
    } catch (e) {
      if (e.response?.status === 429) this._quotaExhausted = true
      if (e.response?.status === 401) logger.warn('🔴 [CLEARSPORTS] Clé API invalide')
      this._lastError = e.message
      return null
    }
  }

  async fetchEvents(dateStr) {
    const data = await this._fetch(`/soccer/games?date=${dateStr || 'today'}`)
    if (!data?.data?.length) return []
    return data.data.map(m => ({
      source: 'clearsports',
      id: `cs_${m.game_key || `${m.home_team?.name}_${m.away_team?.name}`}`,
      homeTeam: m.home_team?.name || 'Home',
      awayTeam: m.away_team?.name || 'Away',
      league: m.league || m.competition || 'Unknown',
      startTimestamp: new Date(m.scheduled_at).getTime() / 1000,
      status: m.status === 'completed' ? 'finished' : m.status === 'in_progress' ? 'live' : 'scheduled',
      scoreHome: m.home_score ?? null,
      scoreAway: m.away_score ?? null
    }))
  }

  async fetchOdds(gameKey) {
    const data = await this._fetch(`/soccer/odds?game_key=${gameKey}`)
    if (!data?.data) return null
    return {
      source: 'clearsports',
      homeOdds: data.data.home_ml,
      drawOdds: data.data.draw_ml,
      awayOdds: data.data.away_ml,
      overUnder: data.data.over_under,
      spread: data.data.spread
    }
  }

  async fetchLiveEvents() {
    const data = await this._fetch('/soccer/games?status=in_progress')
    if (!data?.data?.length) return []
    return data.data.map(m => ({
      source: 'clearsports',
      id: `cs_${m.game_key || `${m.home_team?.name}_${m.away_team?.name}`}`,
      homeTeam: m.home_team?.name || 'Home',
      awayTeam: m.away_team?.name || 'Away',
      league: m.league || m.competition || 'Unknown',
      scoreHome: m.home_score ?? 0,
      scoreAway: m.away_score ?? 0,
      minute: m.minute || '0',
      status: 'live'
    }))
  }
}

module.exports = new ClearSportsService()
