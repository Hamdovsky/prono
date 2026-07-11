const logger = require('../core/logger')
const axios = require('axios')
const sharedConfig = require('../core/sharedConfig')

const CACHE_TTL = 10 * 60 * 1000
const cache = new Map()

class DataFusionService {
  constructor() {
    this.sources = [
      { name: 'fbref',           priority: 1, quota: Infinity, calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'sofascore',       priority: 2, quota: Infinity, calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'scrapeservice',   priority: 3, quota: Infinity, calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'bsd',             priority: 4, quota: 200,      calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'therundown',      priority: 5, quota: 500,      calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'footballdata',    priority: 6, quota: 10,       calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'apifootball',     priority: 7, quota: 100,      calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'oddspapi',        priority: 8, quota: 200,      calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'sportmonks',      priority: 9, quota: 200,      calls: 0, errors: 0, cooldownUntil: 0 },
    ]
    this.quotaWindowMs = 60000
    this.quotaResets = {}
    for (const s of this.sources) {
      this.quotaResets[s.name] = Date.now()
    }
  }

  isSourceAvailable(source) {
    if (source.errors >= 5 && Date.now() - source.cooldownUntil < 0) return false
    if (Date.now() - this.quotaResets[source.name] > this.quotaWindowMs) {
      source.calls = 0
      this.quotaResets[source.name] = Date.now()
    }
    if (source.calls >= source.quota) return false
    return true
  }

  recordSuccess(sourceName) {
    const s = this.sources.find(x => x.name === sourceName)
    if (s) {
      s.calls++
      s.errors = 0
    }
  }

  recordError(sourceName) {
    const s = this.sources.find(x => x.name === sourceName)
    if (s) {
      s.calls++
      s.errors++
      if (s.errors >= 5 && s.cooldownUntil <= Date.now()) {
        s.cooldownUntil = Date.now() + 300000
        logger.warn(`[DATAFUSION] ${sourceName} cooldown 5min after ${s.errors} errors`)
      }
    }
  }

  async fetchOdds(match) {
    if (!match) return null
    const cacheKey = `odds:${match.bsd_match_id || match.sofascore_id || match.id || ''}`
    const cached = cache.get(cacheKey)
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data

    const sorted = [...this.sources].sort((a, b) => a.priority - b.priority)

    for (const source of sorted) {
      if (!this.isSourceAvailable(source)) continue

      try {
        let odds = null
        switch (source.name) {
          case 'fbref':
            odds = await this._tryFbref(match)
            break
          case 'sofascore':
            odds = await this._trySofascore(match)
            break
          case 'scrapeservice':
            odds = await this._tryScrapeService(match)
            break
          case 'bsd':
            odds = await this._tryBsd(match)
            break
          case 'therundown':
            odds = await this._tryTherundown(match)
            break
          case 'footballdata':
            odds = await this._tryFootballdata(match)
            break
          case 'apifootball':
            odds = await this._tryApifootball(match)
            break
          case 'oddspapi':
            odds = await this._tryOddspapi(match)
            break
          case 'sportmonks':
            odds = await this._trySportmonks(match)
            break
        }

        if (odds && odds.home && odds.away) {
          this.recordSuccess(source.name)
          logger.info(`[DATAFUSION] Odds from ${source.name} for ${match.homeTeam} vs ${match.awayTeam}: ${odds.home} / ${odds.draw} / ${odds.away}`)
          cache.set(cacheKey, { ts: Date.now(), data: odds })
          return odds
        }
        this.recordError(source.name)
      } catch (e) {
        this.recordError(source.name)
        logger.debug(`[DATAFUSION] ${source.name} failed for ${match.id}: ${e.message}`)
      }
    }

    logger.warn(`[DATAFUSION] No odds source available for ${match.id} (${match.homeTeam} vs ${match.awayTeam})`)
    return null
  }

  async _getSofaId(match) {
    if (match.sofascore_id) return match.sofascore_id
    // Extract from match ID format: "sofascore_12345"
    if (match.id && typeof match.id === 'string' && match.id.startsWith('sofascore_')) {
      return match.id.replace('sofascore_', '')
    }
    try {
      const fd = typeof match.fullData === 'string' ? JSON.parse(match.fullData) : (match.fullData || {})
      return fd.sofascoreId || fd.sofa_id || fd.sofascore_id || fd.sofaMatchId || null
    } catch { return null }
  }

  async _trySofascore(match) {
    const sofaId = await this._getSofaId(match)
    if (!sofaId) return null
    const oddsService = require('../src/services/oddsService')
    const odds = await oddsService.getLiveOdds(sofaId)
    return odds ? { home: odds.home, draw: odds.draw, away: odds.away } : null
  }

  async _tryScrapeService(match) {
    if (!match.homeTeam || !match.awayTeam) return null
    const scrapeService = require('./scrapeService')
    const result = await scrapeService.getOdds(match.homeTeam, match.awayTeam, match.league || '')
    if (result && result.home_win && result.away_win) {
      return { home: result.home_win, draw: result.draw, away: result.away_win }
    }
    return null
  }

  async _tryBsd(match) {
    const bsdId = match.bsd_match_id
    if (!bsdId) return null
    const bsdService = require('./bsdService')
    if (!bsdService.isAvailable()) return null
    const oddsData = await bsdService.fetchOdds(bsdId)
    if (oddsData && oddsData.odds) {
      const home = oddsData.odds.home_win || null
      const draw = oddsData.odds.draw || null
      const away = oddsData.odds.away_win || null
      if (home && away) return { home, draw, away }
    }
    return null
  }

  async _tryTherundown(match) {
    const trService = require('./therundownService')
    if (!trService.isAvailable()) return null
    const eventId = match.bsd_match_id || match.therundown_id || null
    if (!eventId) return null
    const odds = await trService.fetchOddsForMatch(eventId)
    return odds && odds.home ? odds : null
  }

  async _tryFootballdata(match) {
    const fdService = require('./footballDataService')
    if (!fdService.isAvailable()) return null
    const odds = await fdService.fetchOdds(match)
    return odds && odds.home ? odds : null
  }

  async _tryApifootball(match) {
    const afService = require('./apifootballService')
    if (!afService.isAvailable()) return null
    const fixtureId = match.af_match_id || null
    if (!fixtureId) return null
    const odds = await afService.fetchOdds(fixtureId)
    return odds && odds.home ? odds : null
  }

  async _tryOddspapi(match) {
    const opService = require('./oddspapiService')
    if (!opService.isAvailable()) return null
    const odds = await opService.fetchOddsForMatch(match)
    return odds && odds.home ? odds : null
  }

  async _tryFbref(match) {
    const inferenceUrl = sharedConfig.services.fastapi || 'http://127.0.0.1:8000'
    try {
      const { data } = await axios.post(`${inferenceUrl}/fbref/odds`, {
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        league: match.league || match.tournament || '',
      }, { timeout: 30000 })
      if (data && data.success && data.home && data.away) {
        return { home: data.home, draw: data.draw, away: data.away }
      }
      return null
    } catch (e) {
      logger.debug(`[DATAFUSION] fbref failed for ${match.id}: ${e.message}`)
      return null
    }
  }

  async _trySportmonks(match) {
    const smService = require('./sportmonksService')
    if (!smService.isAvailable()) return null
    const odds = await smService.fetchPrematchOdds(match)
    return odds && odds.home ? odds : null
  }

  getStats() {
    return this.sources.map(s => ({
      name: s.name,
      priority: s.priority,
      calls: s.calls,
      errors: s.errors,
      quota: s.quota,
      available: this.isSourceAvailable(s),
    }))
  }

  resetQuotas() {
    for (const s of this.sources) {
      s.calls = 0
      s.errors = 0
      s.cooldownUntil = 0
      this.quotaResets[s.name] = Date.now()
    }
  }
}

module.exports = new DataFusionService()
