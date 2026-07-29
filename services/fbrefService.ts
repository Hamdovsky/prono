// @ts-nocheck
import axios from 'axios'
import cheerio from 'cheerio'
import logger from '../core/logger'

const LEAGUES = {
  PL: { id: 9, name: 'Premier-League' },
  LA_LIGA: { id: 12, name: 'La-Liga' },
  SERIE_A: { id: 11, name: 'Serie-A' },
  BUNDESLIGA: { id: 20, name: 'Bundesliga' },
  LIGUE_1: { id: 13, name: 'Ligue-1' },
}

const CACHE_TTL = 60 * 60 * 1000
const cache = { teamStats: new Map(), matchStats: new Map() }
const BASE = 'https://fbref.com'

class FbrefService {
  constructor() {
    this.enabled = true
  }

  isAvailable() {
    return this.enabled
  }

  _getCached(key, map) {
    const entry = map.get(key)
    if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data
    return null
  }

  _setCache(key, map, data) {
    map.set(key, { ts: Date.now(), data })
  }

  async fetchPage(url) {
    const res = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
    })
    return cheerio.load(res.data)
  }

  _parseLeagueTable($) {
    const stats = []
    // Standard stats table (goals, xG, assists, xAG)
    const table = $('#stats_standard')
    if (!table.length) return stats

    const rows = table.find('tbody tr')
    rows.each((_, row) => {
      const $row = $(row)
      const team = $row.find('th[data-stat="team"] a').text().trim()
      if (!team) return

      const parseNum = (sel) => {
        const val = $row.find(`td[data-stat="${sel}"]`).text().trim()
        const n = parseFloat(val)
        return isNaN(n) ? null : n
      }

      stats.push({
        team,
        matches: parseNum('games'),
        goals: parseNum('goals'),
        xG: parseNum('xg'),
        assists: parseNum('assists'),
        xAG: parseNum('xag'),
        goalsAgainst: parseNum('goals_against'),
        xGA: parseNum('xg_against'),
        shotsOnTarget: parseNum('shots_on_target'),
        shots: parseNum('shots_total'),
        cleanSheets: parseNum('clean_sheets'),
        possession: parseNum('possession'),
        passesCompleted: parseNum('passes_completed'),
        passCompletionPct: parseNum('pass_pct'),
        progressivePasses: parseNum('progressive_passes'),
        progressiveCarries: parseNum('progressive_carries'),
        tackles: parseNum('tackles'),
        interceptions: parseNum('interceptions'),
        blocks: parseNum('blocks'),
      })
    })
    return stats
  }

  async getTeamStats(leagueCode) {
    const league = LEAGUES[leagueCode]
    if (!league) throw new Error(`Unsupported league: ${leagueCode}`)

    const cacheKey = `teamStats:${leagueCode}`
    const cached = this._getCached(cacheKey, cache.teamStats)
    if (cached) return cached

    const url = `${BASE}/en/comps/${league.id}/${league.name}-Stats`
    const $ = await this.fetchPage(url)
    const stats = this._parseLeagueTable($)

    this._setCache(cacheKey, cache.teamStats, stats)
    logger.info(`[FBREF] Fetched ${stats.length} teams for ${leagueCode}`)
    return stats
  }

  async getMatchStats(matchUrl) {
    const cacheKey = `match:${matchUrl}`
    const cached = this._getCached(cacheKey, cache.matchStats)
    if (cached) return cached

    const $ = await this.fetchPage(matchUrl.startsWith('http') ? matchUrl : `${BASE}${matchUrl}`)

    const result = {}

    // Team names
    result.homeTeam = $('#content h1').text().split(' vs ')[0]?.trim() || ''
    result.awayTeam = $('#content h1').text().split(' vs ')[1]?.trim() || ''

    // Score
    const scoreEl = $('.score')
    if (scoreEl.length) {
      const parts = scoreEl.text().trim().split('–')
      result.homeGoals = parseInt(parts[0]) || 0
      result.awayGoals = parseInt(parts[1]) || 0
    }

    // xG from match summary
    const xgEl = $('.xg_summary')
    if (xgEl.length) {
      result.homeXG = parseFloat(xgEl.find('.home_xg').text()) || null
      result.awayXG = parseFloat(xgEl.find('.away_xg').text()) || null
    }

    // Possession
    const possEl = $('#team_stats_possession')
    if (possEl.length) {
      result.homePossession =
        parseFloat(possEl.find('td[data-stat="possession"]').first().text()) || null
      result.awayPossession =
        parseFloat(possEl.find('td[data-stat="possession"]').last().text()) || null
    }

    this._setCache(cacheKey, cache.matchStats, result)
    return result
  }
}

export = new FbrefService()
