const axios = require('axios')
const logger = require('../core/logger')

const BASE_URL = 'https://api.futpythontrader.com/api'

class FutPythonTraderService {
  constructor() {
    this.apiKey = process.env.FUTPYTHONTRADER_API_KEY || ''
    this.enabled = process.env.FUTPYTHONTRADER_ENABLED !== 'false'
    this._authFailed = false
    this._quotaExhausted = false
    this._sources = ['bet365', 'betfair', 'footystats']

    if (!this.apiKey) {
      logger.warn('[FUTPYTHON] FUTPYTHONTRADER_API_KEY manquant — désactivé')
    } else if (!this.enabled) {
      logger.warn('[FUTPYTHON] Service désactivé (FUTPYTHONTRADER_ENABLED=false)')
    } else {
      logger.info(`[FUTPYTHON] Service prêt — clé: ${this.apiKey.slice(0, 8)}...`)
    }
  }

  isAvailable() {
    if (!this.enabled) return false
    if (!this.apiKey) return false
    if (this._authFailed) return false
    if (this._quotaExhausted) return false
    return true
  }

  _getAuthHeaders() {
    return { Authorization: `Bearer ${this.apiKey}` }
  }

  async _fetch(endpoint) {
    if (!this.isAvailable()) return null

    try {
      const { data } = await axios.get(`${BASE_URL}${endpoint}`, {
        headers: this._getAuthHeaders(),
        timeout: 15000
      })
      return data
    } catch (err) {
      const status = err.response?.status
      if (status === 401 || status === 403) {
        this._authFailed = true
        logger.error(`[FUTPYTHON] Auth failed (${status})`)
      } else if (status === 429) {
        this._quotaExhausted = true
        logger.warn('[FUTPYTHON] Quota exhausted')
      } else if (status === 404) {
        logger.warn(`[FUTPYTHON] Not found: ${endpoint}`)
      } else {
        logger.error(`[FUTPYTHON] Error ${status}: ${err.message}`)
      }
      return null
    }
  }

  async getSources() {
    const d = await this._fetch('/dados/')
    return d?.sources || this._sources
  }

  async getMetadata(source = 'footystats') {
    const d = await this._fetch(`/dados/${source}/metadata/`)
    return d?.leagues || []
  }

  async getMatches(source = 'footystats', params = {}) {
    const query = new URLSearchParams(params).toString()
    const d = await this._fetch(`/dados/${source}/?${query}`)
    return d?.data || []
  }

  async getDailyGames(source = 'footystats', date) {
    const dateStr = date || new Date().toISOString().split('T')[0]
    const d = await this._fetch(`/dados/jogos-do-dia/${source}/${dateStr}/`)
    return d?.data || []
  }

  async syncUpcoming() {
    if (!this.isAvailable()) return 0
    try {
      const database = require('../core/database')
      let total = 0
      for (const source of this._sources) {
        const games = await this.getDailyGames(source)
        if (!games || games.length === 0) continue
        for (const g of games) {
          try {
            const home = g.home_team || g.home || g.mandante || ''
            const away = g.away_team || g.away || g.visitante || ''
            if (!home || !away) continue
            const dateStr = g.date || g.data || g.start_date || ''
            const existing = database.db?.prepare(
              "SELECT id FROM matches WHERE homeTeam = ? AND awayTeam = ? AND DATE(timestamp) = ? LIMIT 1"
            ).get(home, away, dateStr.split('T')[0])
            if (existing) {
              const fd = JSON.parse(database.db.prepare("SELECT fullData FROM matches WHERE id = ?").get(existing.id)?.fullData || '{}')
              if (!fd.futpython) fd.futpython = {}
              fd.futpython[source] = g
              database.db.prepare("UPDATE matches SET fullData = ? WHERE id = ?").run(JSON.stringify(fd), existing.id)
              total++
            }
          } catch (_) {}
        }
      }
      logger.info(`[FUTPYTHON] Sync: ${total} matchs mis à jour`)
      return total
    } catch (e) {
      logger.error(`[FUTPYTHON] Sync error: ${e.message}`)
      return 0
    }
  }
}

module.exports = new FutPythonTraderService()
