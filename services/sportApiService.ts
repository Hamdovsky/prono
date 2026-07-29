// @ts-nocheck
import axios from 'axios'
import logger from '../core/logger'

class SportApiService {
  constructor() {
    this.apiKey = process.env.SPORTAPI_KEY || ''
    this.baseUrl = 'https://api.sportapi.ai'
    this.enabled = process.env.SPORTAPI_ENABLED !== 'false'
    this._lastError = null
    this._quotaExhausted = false

    if (!this.apiKey) {
      logger.warn('🚨 [SPORTAPI] SPORTAPI_KEY manquant — service désactivé')
      this.enabled = false
    } else {
      logger.info(`✅ [SPORTAPI] Service prêt — clé: ${this.apiKey.substring(0, 8)}...`)
    }
  }

  isAvailable() {
    return this.enabled && !!this.apiKey && !this._quotaExhausted
  }

  _headers() {
    return {
      'x-api-key': this.apiKey,
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
      if (e.response?.status === 401) logger.warn('🔴 [SPORTAPI] Clé API invalide')
      this._lastError = e.message
      return null
    }
  }

  async fetchEvents(dateStr) {
    const date = dateStr || new Date().toISOString().split('T')[0]
    const data = await this._fetch(`/v2/football/fixtures?date=${date}`)
    if (!data?.data?.length && !data?.fixtures?.length) return []
    const list = data.data || data.fixtures || []
    return list.map((m) => ({
      source: 'sportapi',
      id: `sa_${m.id || `${m.home_team}_${m.away_team}`}`,
      homeTeam: m.home_team?.name || m.home_team || m.home,
      awayTeam: m.away_team?.name || m.away_team || m.away,
      league: m.league?.name || m.competition || m.tournament || 'Unknown',
      startTimestamp: new Date(m.date || m.start_time || m.scheduled_at).getTime() / 1000,
      status:
        m.status === 'finished'
          ? 'finished'
          : m.status === 'live' || m.status === 'inprogress'
            ? 'live'
            : 'scheduled',
      scoreHome: m.home_score ?? m.score?.home ?? null,
      scoreAway: m.away_score ?? m.score?.away ?? null,
    }))
  }

  async fetchLiveEvents() {
    const data = await this._fetch('/v2/football/live')
    if (!data?.data?.length && !data?.fixtures?.length) return []
    const list = data.data || data.fixtures || []
    return list.map((m) => ({
      source: 'sportapi',
      id: `sa_${m.id || `${m.home_team}_${m.away_team}`}`,
      homeTeam: m.home_team?.name || m.home_team || m.home,
      awayTeam: m.away_team?.name || m.away_team || m.away,
      league: m.league?.name || m.competition || 'Unknown',
      scoreHome: m.home_score ?? m.score?.home ?? 0,
      scoreAway: m.away_score ?? m.score?.away ?? 0,
      minute: m.minute || m.time || '0',
      status: 'live',
    }))
  }

  async fetchOdds(fixtureId) {
    const data = await this._fetch(`/v2/football/odds/${fixtureId}`)
    if (!data?.data && !data?.odds) return null
    const odds = data.data || data.odds
    return {
      source: 'sportapi',
      homeOdds: odds.home || odds['1'],
      drawOdds: odds.draw || odds['X'],
      awayOdds: odds.away || odds['2'],
      overUnder: odds.over_under || odds.ou,
    }
  }
}

export = new SportApiService()
