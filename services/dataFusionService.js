const logger = require('../core/logger')
const axios = require('axios')
const sharedConfig = require('../core/sharedConfig')

const CACHE_TTL = 10 * 60 * 1000
const cache = new Map()

class DataFusionService {
  constructor() {
    this.sources = [
      { name: 'fbref', priority: 1, quota: Infinity, calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'sofascore', priority: 2, quota: Infinity, calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'polymarket', priority: 3, quota: 20, calls: 0, errors: 0, cooldownUntil: 0 },
      {
        name: 'scrapeservice',
        priority: 4,
        quota: Infinity,
        calls: 0,
        errors: 0,
        cooldownUntil: 0,
      },
      { name: 'bsd', priority: 5, quota: 200, calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'therundown', priority: 6, quota: 500, calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'footballdata', priority: 7, quota: 10, calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'apifootball', priority: 8, quota: 100, calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'oddspapi', priority: 9, quota: 200, calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'sportmonks', priority: 10, quota: 200, calls: 0, errors: 0, cooldownUntil: 0 },
      { name: 'oddsapiio', priority: 2, quota: 100, calls: 0, errors: 0, cooldownUntil: 0 },
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
    const s = this.sources.find((x) => x.name === sourceName)
    if (s) {
      s.calls++
      s.errors = 0
    }
  }

  recordError(sourceName) {
    const s = this.sources.find((x) => x.name === sourceName)
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
    let oddsError = null

    // Souces probabilistically-derived odds (xG / prediction-margin) are NOT real
    // bookmaker quotes. They must not be treated as "real odds" for value/honesty.
    const BOOKMAKER_SOURCES = new Set([
      'bsd',
      'therundown',
      'footballdata',
      'apifootball',
      'oddspapi',
      'sportmonks',
      'oddsapiio',
    ])
    // Sources qui renvoient de vraies cotes bookmaker malgré le nom générique.
    const REAL_SCRAPE_SOURCES = new Set([
      'betexplorer',
      'betexplorer+firecrawl',
      'football_data',
      'scraperapi:betexplorer',
      'jina:reader',
      'firecrawl',
      '888sport',
      'unibet',
    ])

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
          case 'polymarket':
            odds = await this._tryPolymarket(match)
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
          case 'oddsapiio':
            odds = await this._tryOddsApiIo(match)
            break
        }

        if (odds && odds.home && odds.away) {
          const isBookmaker =
            BOOKMAKER_SOURCES.has(source.name) || REAL_SCRAPE_SOURCES.has(odds.source)
          const withFlag = { ...odds, bookmaker: isBookmaker }
          this.recordSuccess(source.name)
          logger.info(
            `[DATAFUSION] Odds from ${source.name} for ${match.homeTeam} vs ${match.awayTeam}: ${odds.home} / ${odds.draw} / ${odds.away} ${withFlag.bookmaker ? '(bookmaker)' : '(probability-derived)'}`
          )
          cache.set(cacheKey, { ts: Date.now(), data: withFlag })
          await this._persistOddsOutcome(match, withFlag)
          return withFlag
        }
        if (source.name === 'scrapeservice') {
          if (odds && odds._odds_fetch_error) oddsError = odds._odds_fetch_error
          continue
        }
        this.recordError(source.name)
      } catch (e) {
        this.recordError(source.name)
        logger.debug(`[DATAFUSION] ${source.name} failed for ${match.id}: ${e.message}`)
      }
    }

    await this._persistOddsOutcome(match, null, oddsError)
    logger.warn(
      `[DATAFUSION] No odds source available for ${match.id} (${match.homeTeam} vs ${match.awayTeam})`
    )
    return null
  }

  // Trace le résultat HONNÊTE de la collecte dans matches (voir database.persistOdds):
  // réussite → odds_home/draw/away + odds_source='betexplorer'; échec →
  // odds_source=null + odds_fetch_error=raison. Ne modifie jamais les prédictions.
  async _persistOddsOutcome(match, result, fetchError) {
    try {
      const database = require('../core/database')
      database.persistOdds(match.id, {
        odds_home: result ? result.home : null,
        odds_draw: result ? result.draw : null,
        odds_away: result ? result.away : null,
        odds_source: result ? result.source || 'betexplorer' : null,
        odds_fetch_error: fetchError || (result ? null : 'no_source_available'),
      })
    } catch (_) {
      // La traçabilité ne doit jamais casser la collecte des cotes.
    }
  }

  async _getSofaId(match) {
    if (match.sofascore_id) return match.sofascore_id
    // Extract from match ID format: "sofascore_12345"
    if (match.id && typeof match.id === 'string' && match.id.startsWith('sofascore_')) {
      return match.id.replace('sofascore_', '')
    }
    try {
      const fd =
        typeof match.fullData === 'string' ? JSON.parse(match.fullData) : match.fullData || {}
      return fd.sofascoreId || fd.sofa_id || fd.sofascore_id || fd.sofaMatchId || null
    } catch {
      return null
    }
  }

  async _trySofascore(match) {
    if (process.env.DISABLE_SOFASCORE === 'true') return null
    const sofaId = await this._getSofaId(match)
    // Sofascore search by team name is 403-blocked from Render's IP;
    // only proceed when a Sofascore ID is already known (oddsService routes through scraperProxy if available).
    if (!sofaId) return null
    const oddsService = require('../src/services/oddsService')
    const odds = await oddsService.getLiveOdds(sofaId)
    return odds ? { home: odds.home, draw: odds.draw, away: odds.away } : null
  }

  async _tryScrapeService(match) {
    if (!match.homeTeam || !match.awayTeam)
      return { _odds_fetch_error: 'scraper:no_teams' }
    let country = ''
    if (match.country) {
      country = match.country
    } else if (match.category_name) {
      country = match.category_name
    } else if (match.fullData) {
      try {
        const fd = typeof match.fullData === 'string' ? JSON.parse(match.fullData) : match.fullData
        country = fd.country || fd.category_name || ''
      } catch (_) {}
    }
    const scrapers = require('./scrapers')
    let result = null
    try {
      result = await scrapers.getOdds(match.homeTeam, match.awayTeam, match.league || '', {
        country,
        date: match.startTimestamp || null,
      })
    } catch (e) {
      return { _odds_fetch_error: `scrape_exception:${e.message}` }
    }
    if (!result || !result.home_win || !result.away_win) {
      return { _odds_fetch_error: 'betexplorer:no_match' }
    }
    // HONESTY GATE: les cotes dérivées/probabilités ne sont pas des cotes bookmaker.
    if (
      result.source === 'default' ||
      result.source === 'historical' ||
      result.source === 'historical+elo'
    ) {
      return { _odds_fetch_error: `non_bookmaker:${result.source}` }
    }
    return {
      home: result.home_win,
      draw: result.draw,
      away: result.away_win,
      source: result.source || 'betexplorer',
      bookmaker: true,
    }
  }

  async _tryPolymarket(match) {
    if (!match.homeTeam || !match.awayTeam) return null
    try {
      const https = require('https')
      const url = `https://gamma-api.polymarket.com/markets?closed=false&limit=30&tag=football`
      const data = await new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 8000 }, (res) => {
          let body = ''
          res.on('data', (c) => (body += c))
          res.on('end', () => {
            try {
              resolve(JSON.parse(body))
            } catch (e) {
              reject(e)
            }
          })
        })
        req.on('error', reject)
        req.on('timeout', () => {
          req.destroy()
          reject(new Error('timeout'))
        })
      })
      if (!Array.isArray(data)) return null

      const hName = match.homeTeam.toLowerCase()
      const aName = match.awayTeam.toLowerCase()

      for (const m of data) {
        const q = (m.question || '').toLowerCase()
        if (!q.includes('vs') && !q.includes('beat') && !q.includes('versus')) continue
        if (q.includes(hName) && q.includes(aName)) {
          const prices =
            typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices
          if (prices && prices.length >= 2) {
            const homeProb = parseFloat(prices[0])
            const awayProb = parseFloat(prices[1])
            if (homeProb > 0 && awayProb > 0) {
              return {
                home: +(1 / homeProb).toFixed(2),
                draw: +(1 - homeProb - awayProb > 0
                  ? (1 / (1 - homeProb - awayProb)).toFixed(2)
                  : 3.0),
                away: +(1 / awayProb).toFixed(2),
              }
            }
          }
        }
      }
    } catch (_) {}
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
      const { data } = await axios.post(
        `${inferenceUrl}/fbref/odds`,
        {
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          league: match.league || match.tournament || '',
        },
        { timeout: 30000 }
      )
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

  async _tryOddsApiIo(match) {
    const oaService = require('./oddsApiIoService')
    if (!oaService.isAvailable()) return null
    const odds = await oaService.fetchOddsForMatch(match)
    return odds && odds.home ? odds : null
  }

  getStats() {
    return this.sources.map((s) => ({
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
