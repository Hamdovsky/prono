const axios = require('axios')
const logger = require('../core/logger')

const BASE_URL = 'https://api.bigballsdata.com'

class BigBallsDataService {
  constructor() {
    this.apiKey = process.env.BBS_API_KEY || ''
    this.enabled = process.env.BBS_ENABLED !== 'false'
    this._authFailed = false
    this._quotaExhausted = false

    if (!this.apiKey) {
      logger.warn('[BBS] BBS_API_KEY manquant — désactivé')
    } else if (!this.enabled) {
      logger.warn('[BBS] Service désactivé (BBS_ENABLED=false)')
    } else {
      logger.info(`[BBS] Service prêt — clé: ${this.apiKey.slice(0, 12)}...`)
    }
  }

  isAvailable() {
    if (!this.enabled) return false
    if (!this.apiKey) return false
    if (this._authFailed) return false
    if (this._quotaExhausted) return false
    return true
  }

  async _fetch(endpoint) {
    if (!this.isAvailable()) return null

    try {
      const { data } = await axios.get(`${BASE_URL}${endpoint}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeout: 10000,
      })
      if (data.error) {
        if (data.error.code === 'unauthorized' || data.error.code === 'forbidden') {
          this._authFailed = true
          logger.error(`[BBS] Auth failed: ${data.error.message}`)
        }
        return null
      }
      return data
    } catch (err) {
      const status = err.response?.status
      if (status === 401 || status === 403) {
        this._authFailed = true
        logger.error(`[BBS] Auth failed (${status})`)
      } else if (status === 429) {
        this._quotaExhausted = true
        logger.warn('[BBS] Quota exhausted')
      } else {
        logger.error(`[BBS] Error ${status}: ${err.message}`)
      }
      return null
    }
  }

  async getSports() {
    const d = await this._fetch('/v1/sports')
    return d?.data || []
  }

  async getLeagues() {
    const d = await this._fetch('/v1/leagues?sport=football')
    return d?.data || []
  }

  async getMatches(league = 'epl', status = 'scheduled') {
    const d = await this._fetch(`/v1/matches?sport=football&league=${league}&status=${status}`)
    return d?.data || []
  }

  async getMatchOdds(matchId) {
    const d = await this._fetch(`/v1/matches/${matchId}/odds`)
    return d?.data || null
  }

  async getMatchStats(matchId) {
    const d = await this._fetch(`/v1/stored/matches/${matchId}/stats`)
    return d?.data || null
  }

  async getMatchLineups(matchId) {
    const d = await this._fetch(`/v1/stored/matches/${matchId}/lineups`)
    return d?.data || null
  }

  async getPlayerStats(playerId) {
    const d = await this._fetch(`/v1/players/${playerId}/stats?sport=football`)
    return d?.data || null
  }

  async syncUpcoming() {
    if (!this.isAvailable()) return 0
    try {
      const leagues = await this.getLeagues()
      if (!leagues || leagues.length === 0) return 0

      const database = require('../core/database')
      let updated = 0

      for (const league of leagues) {
        const matches = await this.getMatches(league.id, 'scheduled')
        if (!matches || matches.length === 0) continue

        for (const m of matches) {
          try {
            const existing = database.db
              ?.prepare(
                'SELECT id FROM matches WHERE homeTeam = ? AND awayTeam = ? AND DATE(timestamp) = ? LIMIT 1'
              )
              .get(m.home, m.away, m.date?.split('T')[0] || '')

            if (existing) {
              // Merge gardé : n'ajoute QUE la clé namespace, ne touche jamais
              // prediction/confidence/quant/verdict (ré-injection colonnes→fullData).
              database.mergeFullData(existing.id, 'bigballs', { matchId: m.id, league: league.id })
              updated++
            }
          } catch (_) {}
        }
      }

      logger.info(`[BBS] Sync: ${updated} matchs mis à jour`)
      return updated
    } catch (e) {
      logger.error(`[BBS] Sync error: ${e.message}`)
      return 0
    }
  }
}

module.exports = new BigBallsDataService()
