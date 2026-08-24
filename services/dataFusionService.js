const logger = require('../core/logger')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const sharedConfig = require('../core/sharedConfig')

const CACHE_TTL = 10 * 60 * 1000
const cache = new Map()

// ── Audit Phase 1 FD-Odds bridge (2026-08-24) ─────────────────────────────
// Cotes RÉELLES bookmaker depuis les CSV football-data.co.uk téléchargés
// chaque matin à 07h00 par le pipeline data (data_pipeline/data/raw/).
// 100 % gratuit/local, aucun scraping réseau. Priorité cotes : Avg → B365 →
// Pinnacle(PP)/SkyBet(SKB) ; O/U 2.5 : Avg → B365 (+close).
const FOOTBALL_DATA_ROOT = path.join(__dirname, '..', 'data_pipeline', 'data', 'raw')
const FOOTBALL_DATA_FILES = [
  // fixtures en premier -> prioritaire sur les résultats dans l'index
  path.join(FOOTBALL_DATA_ROOT, 'football_data_fixtures.csv'),
  path.join(FOOTBALL_DATA_ROOT, 'football_data_all.csv'),
]
const _fdCache = { index: null, mtimes: '' }
let _fdAliasMap = null

function _stripAccents(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function _normalizeTeamName(name) {
  const s = _stripAccents(String(name || '').toLowerCase())
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  try {
    if (!_fdAliasMap) {
      const aliasPath = path.join(__dirname, '..', 'data_pipeline', 'data', 'team_aliases.json')
      if (fs.existsSync(aliasPath)) {
        const j = JSON.parse(fs.readFileSync(aliasPath, 'utf8'))
        _fdAliasMap = new Map()
        for (const [canon, arr] of Object.entries(j.aliases || {})) {
          for (const a of Array.isArray(arr) ? arr : []) {
            _fdAliasMap.set(_stripAccents(String(a).toLowerCase()), canon.toLowerCase())
          }
        }
        for (const canon of j.canonical ? j.canonical.split(/\s{2,}|\n/) : []) {
          const c = _stripAccents(String(canon).toLowerCase()).trim()
          if (c) _fdAliasMap.set(c, c)
        }
      } else {
        _fdAliasMap = new Map()
      }
    }
    return _fdAliasMap.get(s) || s
  } catch (_) {
    return s
  }
}

function _parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQ = false
      } else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

const _FD_ODDS_COLS = {
  home: ['odds_h_avg', 'odds_h_b365', 'odds_h_pp', 'odds_h_skb'],
  draw: ['odds_d_avg', 'odds_d_b365', 'odds_d_pp', 'odds_d_skb'],
  away: ['odds_a_avg', 'odds_a_b365', 'odds_a_pp', 'odds_a_skb'],
  over25: ['odds_o25_avg', 'odds_o25_b365', 'odds_o25_close_avg', 'odds_o25_close_b365'],
  under25: ['odds_u25_avg', 'odds_u25_b365', 'odds_u25_close_avg', 'odds_u25_close_b365'],
}

function _loadFootballData() {
  const files = FOOTBALL_DATA_FILES
  let mtimes = ''
  for (const f of files) {
    try {
      mtimes += String(fs.statSync(f).mtimeMs) + '|'
    } catch {
      mtimes += 'missing|'
    }
  }
  if (_fdCache.index && _fdCache.mtimes === mtimes) return _fdCache.index

  const index = new Map()
  for (const f of files) {
    let text = ''
    try {
      text = fs.readFileSync(f, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
    if (lines.length < 2) continue
    const header = _parseCsvLine(lines[0])
    const idxOf = (name) => header.indexOf(name)
    const iDate = idxOf('date')
    const iHome = idxOf('home_team')
    const iAway = idxOf('away_team')
    if (iDate < 0 || iHome < 0 || iAway < 0) continue
    const colIdx = {}
    for (const [k, cols] of Object.entries(_FD_ODDS_COLS)) {
      colIdx[k] = cols.map((c) => idxOf(c)).filter((i) => i >= 0)
    }
    for (let li = 1; li < lines.length; li++) {
      const cells = _parseCsvLine(lines[li])
      const date = (cells[iDate] || '').trim()
      const hRaw = (cells[iHome] || '').trim()
      const aRaw = (cells[iAway] || '').trim()
      if (!date || !hRaw || !aRaw) continue
      const entry = { date, homeTeam: hRaw, awayTeam: aRaw }
      for (const [k, idxs] of Object.entries(colIdx)) {
        for (const i of idxs) {
          const v = parseFloat(cells[i])
          if (Number.isFinite(v) && v > 1) {
            entry[k] = v
            break
          }
        }
      }
      const h = _normalizeTeamName(hRaw)
      const a = _normalizeTeamName(aRaw)
      // fixtures.csv chargé en premier -> prioritaire sur all.csv
      const k1 = `${date}|${h}|${a}`
      if (!index.has(k1)) index.set(k1, entry)
      const k2 = `${date}|${a}|${h}`
      if (!index.has(k2)) index.set(k2, entry)
    }
  }
  _fdCache.index = index
  _fdCache.mtimes = mtimes
  logger.info(`[DATAFUSION] football-data index chargé: ${index.size} lignes`)
  return index
}


class DataFusionService {
  constructor() {
    this.sources = [
      // Audit cotes (2026-08-24) : fbref RETIRÉ de la chaîne odds.
      // _tryFbref pendait 30s (timeout) par match AVANT d'atteindre les vraies
      // sources, et fbref ne fournit aucune cote bookmaker (stats xG uniquement,
      // exclu de BOOKMAKER_SOURCES) → sweep 0/549, couverture 1X2 47/1239.
      // Audit cotes (2026-08-24) : chaîne réduite aux seules sources gratuites
      // réellement fonctionnelles. Les stubs d'APIs payantes (polymarket, bsd,
      // therundown, apifootball, oddspapi, sportmonks, oddsapiio) brûlaient 5
      // erreurs + cooldown chacun par match sans jamais renvoyer de cote.
      { name: 'sofascore', priority: 2, quota: Infinity, calls: 0, errors: 0, cooldownUntil: 0 },
      {
        name: 'scrapeservice',
        priority: 4,
        quota: Infinity,
        calls: 0,
        errors: 0,
        cooldownUntil: 0,
      },
      // CSV local football-data.co.uk (refresh 07h00) : gratuit et illimité.
      { name: 'footballdata', priority: 7, quota: Infinity, calls: 0, errors: 0, cooldownUntil: 0 },
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
      'footballdata',
      // Sofascore agrège des cotes réelles de bookmakers partenaires.
      'sofascore',
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

        // Recherche propre sans données (équipe/rencontre absentes de la
        // source) : ce n'est PAS une erreur de source — pas de cooldown.
        if (odds && odds._odds_no_data) {
          oddsError = oddsError || 'no_data'
          continue
        }

        // Market-only accepté: 1X2 OU O/U 2.5 OU BTTS (pas besoin d'avoir tout).
        const has1x2 = odds && odds.home && odds.away
        const hasOu = odds && (odds.over25 != null || odds.under25 != null)
        const hasBtts = odds && (odds.btts_yes != null || odds.btts_no != null)
        if (has1x2 || hasOu || hasBtts) {
          const isBookmaker =
            BOOKMAKER_SOURCES.has(source.name) || REAL_SCRAPE_SOURCES.has(odds.source)
          const withFlag = { ...odds, bookmaker: isBookmaker }
          this.recordSuccess(source.name)
          const logLine = has1x2
            ? `${odds.home} / ${odds.draw} / ${odds.away}`
            : `${odds.over25 ?? '—'} / ${odds.under25 ?? '—'} / BTTS ${odds.btts_yes ?? '—'}`
          logger.info(
            `[DATAFUSION] Odds from ${source.name} for ${match.homeTeam} vs ${match.awayTeam}: ${logLine} ${withFlag.bookmaker ? '(bookmaker)' : '(probability-derived)'}`
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
  // réussite → odds_home/draw/away (+ O/U 2.5 + BTTS si fournis) + odds_source='betexplorer';
  // échec → odds_source=null + odds_fetch_error=raison. Ne modifie jamais les prédictions.
  async _persistOddsOutcome(match, result, fetchError) {
    try {
      const database = require('../core/database')
      database.persistOdds(match.id, {
        odds_home: result ? result.home : null,
        odds_draw: result ? result.draw : null,
        odds_away: result ? result.away : null,
        odds_over25: result ? result.over25 : null,
        odds_under25: result ? result.under25 : null,
        odds_btts_yes: result ? result.btts_yes : null,
        odds_btts_no: result ? result.btts_no : null,
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
    // Audit Phase 2 : accès via curl_cffi (scripts/sofascore_bypass.py) —
    // contournement du ban TLS/IP ; resolve auto de l'event id si absent.
    const sofaId = await this._getSofaId(match)
    const bypass = require('./scrapers/SofascoreBypass')
    const odds = await bypass.getOddsForMatch({
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      startTimestamp: match.startTimestamp || null,
      sofascore_id: sofaId,
    })
    return odds || { _odds_no_data: true }
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
    const has1x2 = result && result.home_win && result.away_win
    const hasOu = result && (result.over_25 != null || result.over25 != null)
    const hasBtts = result && (result.btts_yes != null || result.bttsYes != null)
    if (!result || (!has1x2 && !hasOu && !hasBtts)) {
      return { _odds_fetch_error: 'betexplorer:no_match' }
    }
    // HONESTY GATE: les cotes dérivées/probabilités ne sont pas des cotes bookmaker.
    // On ne garde le marché que s'il provient d'une vraie source (betexplorer/BSD/etc).
    if (
      result.source === 'default' ||
      result.source === 'historical' ||
      result.source === 'historical+elo'
    ) {
      return { _odds_fetch_error: `non_bookmaker:${result.source}` }
    }
    const out = {
      home: result.home_win ?? null,
      draw: result.draw ?? null,
      away: result.away_win ?? null,
      source: result.source || 'betexplorer',
      bookmaker: true,
    }
    const over25 = result.over_25 || result.over25 || null
    const under25 = result.under_25 || result.under25 || null
    const bttsYes = result.btts_yes || result.bttsYes || null
    const bttsNo = result.btts_no || result.bttsNo || null
    if (over25 != null || under25 != null || bttsYes != null || bttsNo != null) {
      out.over25 = over25
      out.under25 = under25
      out.btts_yes = bttsYes
      out.btts_no = bttsNo
    }
    return out
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
    const bsdService = new Proxy({}, { get: (t, p) => (p === 'isAvailable' ? () => false : (p === 'then' ? undefined : (async () => null))) });
    if (!bsdService.isAvailable()) return null
    const oddsData = await bsdService.fetchOdds(bsdId)
    if (oddsData) {
      const home = oddsData.home || oddsData.odds?.home_win || null
      const draw = oddsData.draw || oddsData.odds?.draw || null
      const away = oddsData.away || oddsData.odds?.away_win || null
      if (home && away) {
        return {
          home,
          draw,
          away,
          over25: oddsData.over25 || null,
          under25: oddsData.under25 || null,
          btts_yes: oddsData.btts_yes || null,
          btts_no: oddsData.btts_no || null,
        }
      }
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
    // Audit Phase 1 FD-Odds bridge : lookup RÉEL dans les CSV football-data
    // (fixtures + résultats, refresh 07h00). Cotes décimales bookmaker.
    try {
      const index = _loadFootballData()
      if (!index || index.size === 0) return null

      const tsRaw = Number(match.startTimestamp)
      let ts = Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : Date.parse(match.timestamp || '')
      if (Number.isFinite(ts)) {
        if (ts < 1e11) ts *= 1000 // secondes -> ms
      } else ts = NaN
      if (!Number.isFinite(ts) || ts <= 0) return null

      const h = _normalizeTeamName(match.homeTeam)
      const a = _normalizeTeamName(match.awayTeam)
      for (const off of [0, -86400000, 86400000]) {
        const ds = new Date(ts + off).toISOString().slice(0, 10)
        for (const key of [`${ds}|${h}|${a}`, `${ds}|${a}|${h}`]) {
          const row = index.get(key)
          if (row && (row.home || row.over25)) {
            logger.info(
              `[DATAFUSION] football-data: ${row.homeTeam} vs ${row.awayTeam} (${row.date}) -> ${row.home ?? '—'}/${row.draw ?? '—'}/${row.away ?? '—'} O/U: ${row.over25 ?? '—'}/${row.under25 ?? '—'}`
            )
            return {
              home: row.home ?? null,
              draw: row.draw ?? null,
              away: row.away ?? null,
              over25: row.over25 ?? null,
              under25: row.under25 ?? null,
              source: 'footballdata',
            }
          }
        }
      }
      return { _odds_no_data: true }
    } catch (e) {
      return { _odds_fetch_error: `footballdata:${e.message}` }
    }
  }

  async _tryApifootball(match) {
    const afService = new Proxy({}, { get: (t, p) => (p === 'isAvailable' ? () => false : (p === 'then' ? undefined : (async () => null))) });
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
