const axios = require('axios')
const logger = require('../core/logger')

const OPENLIGADB_BASE = 'https://api.openligadb.de'
const REQUEST_TIMEOUT_MS = 12000
const GROUP_CACHE_TTL_MS = 12 * 60 * 60 * 1000 // current group changes ~weekly
const MATCHDAY_CACHE_TTL_MS = 10 * 60 * 1000 // same matchday is refetched for each scan date
const CONCURRENCY = 2
const LEAGUE_PACE_MS = 400

// Ligues avec un "current group" valide sur api.openligadb.de (gratuit, sans clé).
// Les slugs sans groupe courant (ex. EM/WC/Nations League hors saison, compétitions
// non couvertes) renvoient 404 et sont retirées pour éviter les requêtes inutiles.
// short cut valides vérifiés : bl1, bl2, bl3, dfb, ucl, uel, ch1, Eredivisie.
const LEAGUES = [
  { shortcut: 'bl1', name: 'Bundesliga 1', country: 'Germany' },
  { shortcut: 'bl2', name: 'Bundesliga 2', country: 'Germany' },
  { shortcut: 'bl3', name: '3. Liga', country: 'Germany' },
  { shortcut: 'dfb', name: 'DFB-Pokal', country: 'Germany' },
  { shortcut: 'ucl', name: 'Champions League', country: 'Europe' },
  { shortcut: 'uel', name: 'Europa League', country: 'Europe' },
  { shortcut: 'ch1', name: 'Swiss Super League', country: 'Switzerland' },
  { shortcut: 'Eredivisie', name: 'Eredivisie', country: 'Netherlands' },
]

// Runs async work over an array with a fixed concurrency limit.
function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++
      results[i] = await fn(items[i], i)
    }
  })
  return Promise.all(workers).then(() => results)
}

function finalResult(match) {
  const res = match.matchResults || []
  for (const r of res) {
    const name = (r.resultName || '').toLowerCase()
    if (name.includes('end') || name.includes('final') || name.includes('total')) {
      return r
    }
  }
  return res[0] || null
}

function halfTimeResult(match) {
  const res = match.matchResults || []
  for (const r of res) {
    const name = (r.resultName || '').toLowerCase()
    if (name.includes('halb') || name.includes('half') || name.includes('1.hz')) {
      return r
    }
  }
  return null
}

class OpenLigaDBService {
  constructor() {
    this.enabled = process.env.OPENLIGADB_ENABLED !== 'false'
    this._groupCache = new Map() // shortcut -> { ts, group }
    this._matchdayCache = new Map() // shortcut|season|group -> { ts, data }
    logger.info(
      `✅ [OPENLIGADB] Service prêt — ${LEAGUES.length} ligues configurées (gratuit, sans clé)`
    )
  }

  isAvailable() {
    return this.enabled
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async _fetch(endpoint, attempt = 0) {
    try {
      const { data } = await axios.get(`${OPENLIGADB_BASE}${endpoint}`, {
        timeout: REQUEST_TIMEOUT_MS,
      })
      return data
    } catch (e) {
      const status = e.response?.status
      // 429 = rate limited: back off and retry up to twice before giving up.
      if ((status === 429 || status >= 500) && attempt < 2) {
        const backoff = 1000 * (attempt + 1)
        logger.warn(`[OPENLIGADB] GET ${endpoint} ${status} -> retry ${attempt + 1} in ${backoff}ms`)
        await this._sleep(backoff)
        return this._fetch(endpoint, attempt + 1)
      }
      if (status === 404) return null
      logger.warn(`[OPENLIGADB] GET ${endpoint} failed: ${e.message}`)
      return null
    }
  }

  async _getCurrentGroup(leagueShortcut) {
    const cached = this._groupCache.get(leagueShortcut)
    if (cached && Date.now() - cached.ts < GROUP_CACHE_TTL_MS) {
      return cached.group
    }
    const data = await this._fetch(`/getcurrentgroup/${leagueShortcut}`)
    const group = data && data.groupOrderID ? data : null
    this._groupCache.set(leagueShortcut, { ts: Date.now(), group })
    return group
  }

  async _getMatchday(leagueShortcut, season, groupOrderID) {
    const key = `${leagueShortcut}|${season}|${groupOrderID}`
    const cached = this._matchdayCache.get(key)
    if (cached && Date.now() - cached.ts < MATCHDAY_CACHE_TTL_MS) {
      return cached.data
    }
    const data = await this._fetch(`/getmatchdata/${leagueShortcut}/${season}/${groupOrderID}`)
    if (!Array.isArray(data)) return [] // do not cache failures/rate-limits
    this._matchdayCache.set(key, { ts: Date.now(), data })
    return data
  }

  _mapToMatch(match, leagueShortcut, leagueName, leagueCountry) {
    const ts = new Date(match.matchDateTimeUTC || match.matchDateTime).getTime() / 1000
    const homeTeam = match.team1?.teamName || 'Home'
    const awayTeam = match.team2?.teamName || 'Away'

    return {
      id: `oldb_${match.matchID}`,
      homeTeam,
      awayTeam,
      league: match.leagueName || leagueName,
      category_name: leagueCountry || 'Germany',
      tournament_name: match.leagueName || leagueName,
      tournament_id: match.leagueId || null,
      home_team_id: String(match.team1?.teamId || ''),
      away_team_id: String(match.team2?.teamId || ''),
      startTimestamp: ts,
      timestamp: new Date(ts * 1000).toISOString(),
      status: match.matchIsFinished ? 'finished' : 'scheduled',
      confidence: 50,
      prediction: null,
      verdict: 'PENDING',
      odds_home: null,
      odds_draw: null,
      odds_away: null,
      last_updated: Date.now(),
      insufficient_data: 1,
      source: 'openligadb',
      fullData: JSON.stringify({
        id: match.matchID,
        homeTeam,
        awayTeam,
        league: match.leagueName || leagueName,
        startTimestamp: ts,
        status: match.matchIsFinished ? 'finished' : 'scheduled',
        leagueShortcut,
        groupOrderID: match.group?.groupOrderID,
      }),
    }
  }

  _mapResult(match, leagueShortcut, leagueName, leagueCountry) {
    const base = this._mapToMatch(match, leagueShortcut, leagueName, leagueCountry)
    const fin = finalResult(match)
    if (!fin) return null
    const scoreHome = parseInt(fin.pointsTeam1, 10)
    const scoreAway = parseInt(fin.pointsTeam2, 10)
    if (Number.isNaN(scoreHome) || Number.isNaN(scoreAway)) return null
    const half = halfTimeResult(match)
    return {
      ...base,
      status: 'finished',
      scoreHome,
      scoreAway,
      scoreHalfHome: half ? parseInt(half.pointsTeam1, 10) || 0 : 0,
      scoreHalfAway: half ? parseInt(half.pointsTeam2, 10) || 0 : 0,
    }
  }

  async _leagueFixtures(league, dateStr, targetDate, nextDay) {
    const group = await this._getCurrentGroup(league.shortcut)
    if (!group) return []

    const seasons = [2025, 2026]
    const matches = []
    for (const season of seasons) {
      const data = await this._getMatchday(league.shortcut, season, group.groupOrderID)
      if (!data.length) continue

      for (const match of data) {
        if (match.matchIsFinished) continue
        const matchDate = new Date(match.matchDateTimeUTC || match.matchDateTime)
        if (matchDate >= targetDate && matchDate < nextDay) {
          matches.push(this._mapToMatch(match, league.shortcut, league.name, league.country))
        }
      }
      break // Only try next season if current season had no data
    }
    await this._sleep(LEAGUE_PACE_MS) // pace requests to avoid 429 rate limiting
    return matches
  }

  async fetchEvents(dateStr) {
    if (!this.isAvailable()) return []

    const targetDate = new Date(dateStr + 'T00:00:00Z')
    const nextDay = new Date(targetDate.getTime() + 86400000)

    const perLeague = await mapLimit(LEAGUES, CONCURRENCY, (league) =>
      this._leagueFixtures(league, dateStr, targetDate, nextDay)
    )
    return perLeague.flat()
  }

  // Finished matches of the current (or previous) matchday whose kick-off fell
  // inside the requested date window. Used as a settlement fallback so the
  // results pass does not depend solely on the Livescore API.
  async fetchResults(dateStr) {
    if (!this.isAvailable()) return []

    const targetDate = new Date(dateStr + 'T00:00:00Z')
    const nextDay = new Date(targetDate.getTime() + 86400000)

    const perLeague = await mapLimit(LEAGUES, CONCURRENCY, async (league) => {
      const group = await this._getCurrentGroup(league.shortcut)
      if (!group) return []

      const seasons = [2025, 2026]
      const out = []
      for (const season of seasons) {
        const current = await this._getMatchday(league.shortcut, season, group.groupOrderID)
        const previousId =
          group.groupOrderID && Number(group.groupOrderID) > 1
            ? Number(group.groupOrderID) - 1
            : null
        const previous = previousId
          ? await this._getMatchday(league.shortcut, season, previousId)
          : []
        const data = [...current, ...previous]

        for (const match of data) {
          if (!match.matchIsFinished) continue
          const matchDate = new Date(match.matchDateTimeUTC || match.matchDateTime)
          if (matchDate >= targetDate && matchDate < nextDay) {
            const row = this._mapResult(match, league.shortcut, league.name, league.country)
            if (row) out.push(row)
          }
        }
        break // Only try next season if current season had no data
      }
      await this._sleep(LEAGUE_PACE_MS)
      return out
    })
    return perLeague.flat()
  }

  async fullSync() {
    if (!this.isAvailable()) {
      logger.warn('[OPENLIGADB] Full sync skipped — service disabled')
      return 0
    }

    const database = require('../core/database')
    let total = 0

    for (const league of LEAGUES) {
      const group = await this._getCurrentGroup(league.shortcut)
      if (!group) {
        logger.info(`[OPENLIGADB] ${league.name}: no current group found`)
        continue
      }

      const seasons = [2025, 2026]
      for (const season of seasons) {
        const data = await this._getMatchday(league.shortcut, season, group.groupOrderID)
        if (!data.length) {
          logger.info(
            `[OPENLIGADB] ${league.name} season ${season}/${season + 1}: no data for matchday ${group.groupOrderID}`
          )
          continue
        }

        let inserted = 0
        for (const match of data) {
          if (match.matchIsFinished) continue
          try {
            const mapped = this._mapToMatch(match, league.shortcut, league.name, league.country)
            await database.insertMatch(mapped)
            inserted++
          } catch (e) {
            logger.warn(`[OPENLIGADB] insert error for match ${match.matchID}: ${e.message}`)
          }
        }

        if (inserted > 0) {
          logger.info(
            `[OPENLIGADB] ${league.name}: inserted ${inserted} matches (matchday ${group.groupOrderID})`
          )
          total += inserted
        }
        break // Only try next season if this season had no data
      }
    }

    logger.info(`[OPENLIGADB] Full sync complete: ${total} matches total`)
    return total
  }
}

module.exports = new OpenLigaDBService()