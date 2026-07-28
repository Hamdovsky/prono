const axios = require('axios')
const logger = require('../core/logger')

const OPENLIGADB_BASE = 'https://api.openligadb.de'

const LEAGUES = [
  { shortcut: 'bl1', name: 'Bundesliga 1' },
  { shortcut: 'bl2', name: 'Bundesliga 2' },
  { shortcut: 'bl3', name: '3. Liga' },
  { shortcut: 'dfb', name: 'DFB-Pokal' },
  { shortcut: 'ucl', name: 'Champions League' },
  { shortcut: 'uel', name: 'Europa League' },
]

class OpenLigaDBService {
  constructor() {
    this.enabled = process.env.OPENLIGADB_ENABLED !== 'false'
    logger.info(
      `✅ [OPENLIGADB] Service prêt — ${LEAGUES.length} ligues configurées (gratuit, sans clé)`
    )
  }

  isAvailable() {
    return this.enabled
  }

  async _fetch(endpoint) {
    try {
      const { data } = await axios.get(`${OPENLIGADB_BASE}${endpoint}`, { timeout: 10000 })
      return data
    } catch (e) {
      logger.warn(`[OPENLIGADB] GET ${endpoint} failed: ${e.message}`)
      return null
    }
  }

  async _getCurrentGroup(leagueShortcut) {
    const data = await this._fetch(`/getcurrentgroup/${leagueShortcut}`)
    if (!data || !data.groupOrderID) return null
    return data
  }

  async _getMatchday(leagueShortcut, season, groupOrderID) {
    const data = await this._fetch(`/getmatchdata/${leagueShortcut}/${season}/${groupOrderID}`)
    return Array.isArray(data) ? data : []
  }

  _mapToMatch(match, leagueShortcut, leagueName) {
    const ts = new Date(match.matchDateTimeUTC || match.matchDateTime).getTime() / 1000
    const homeTeam = match.team1?.teamName || 'Home'
    const awayTeam = match.team2?.teamName || 'Away'

    return {
      id: `oldb_${match.matchID}`,
      homeTeam,
      awayTeam,
      league: match.leagueName || leagueName,
      category_name: 'Germany',
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

  async fetchEvents(dateStr) {
    if (!this.isAvailable()) return []

    const matches = []
    const targetDate = new Date(dateStr + 'T00:00:00Z')
    const nextDay = new Date(targetDate.getTime() + 86400000)

    for (const league of LEAGUES) {
      const group = await this._getCurrentGroup(league.shortcut)
      if (!group) continue

      const seasons = [2025, 2026]
      for (const season of seasons) {
        const data = await this._getMatchday(league.shortcut, season, group.groupOrderID)
        if (!data.length) continue

        for (const match of data) {
          if (match.matchIsFinished) continue
          const matchDate = new Date(match.matchDateTimeUTC || match.matchDateTime)
          if (matchDate >= targetDate && matchDate < nextDay) {
            matches.push(this._mapToMatch(match, league.shortcut, league.name))
          }
        }
        break // Only try next season if current season had no data
      }
    }

    return matches
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
            const mapped = this._mapToMatch(match, league.shortcut, league.name)
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
