// @ts-nocheck
import fs from 'fs'
import path from 'path'
import logger from '../core/logger'

class PromosportSurpriseService {
  constructor() {
    this.historicalData = null
    this.surpriseRates = null
    this.lastLoaded = 0
    this.TTL = 3600000
  }

  load() {
    if (this.historicalData && Date.now() - this.lastLoaded < this.TTL) return
    try {
      const p = path.join(__dirname, '..', 'data', 'promosport_historical_results.json')
      if (!fs.existsSync(p)) {
        logger.warn('[SURPRISE] No historical data found')
        this.historicalData = []
        return
      }
      this.historicalData = JSON.parse(fs.readFileSync(p, 'utf-8'))
      logger.info(`[SURPRISE] Loaded ${this.historicalData.length} historical concours`)
      this.lastLoaded = Date.now()
    } catch (err) {
      logger.error('[SURPRISE] Failed to load:', err.message)
      this.historicalData = []
    }
  }

  computeSurpriseRates() {
    this.load()
    if (!this.historicalData || this.historicalData.length === 0) return {}

    const favoriteWins = { home: 0, away: 0, total: 0 }
    const favoriteFails = { home: 0, away: 0, total: 0 }
    const draws = { home: 0, away: 0, total: 0 }
    const teamStats = {}

    this.historicalData.forEach((concours) => {
      ;(concours.matches || []).forEach((m) => {
        const home = (m.home || '').trim().toLowerCase()
        const away = (m.away || '').trim().toLowerCase()
        const res = (m.res || '').trim()

        if (!home || !away || !res) return

        if (!teamStats[home])
          teamStats[home] = {
            home: { wins: 0, draws: 0, losses: 0 },
            away: { wins: 0, draws: 0, losses: 0 },
            total: { wins: 0, draws: 0, losses: 0 },
          }
        if (!teamStats[away])
          teamStats[away] = {
            home: { wins: 0, draws: 0, losses: 0 },
            away: { wins: 0, draws: 0, losses: 0 },
            total: { wins: 0, draws: 0, losses: 0 },
          }

        if (res === '1') {
          teamStats[home].home.wins++
          teamStats[home].total.wins++
          teamStats[away].away.losses++
          teamStats[away].total.losses++
          favoriteWins.home++
        } else if (res === '2') {
          teamStats[away].away.wins++
          teamStats[away].total.wins++
          teamStats[home].home.losses++
          teamStats[home].total.losses++
          favoriteWins.away++
        } else if (res === 'X') {
          teamStats[home].home.draws++
          teamStats[home].total.draws++
          teamStats[away].away.draws++
          teamStats[away].total.draws++
          draws.home++
          draws.away++
        }
        favoriteWins.total++
      })
    })

    const totalMatches = favoriteWins.total + draws.total
    this.surpriseRates = {
      globalDrawRate: totalMatches > 0 ? +((draws.total / totalMatches) * 100).toFixed(1) : 0,
      globalHomeWinRate:
        totalMatches > 0 ? +((favoriteWins.home / totalMatches) * 100).toFixed(1) : 0,
      globalAwayWinRate:
        totalMatches > 0 ? +((favoriteWins.away / totalMatches) * 100).toFixed(1) : 0,
      teamStats: this._computeTeamSurprise(teamStats),
      totalConcours: this.historicalData.length,
      totalMatches,
    }
    return this.surpriseRates
  }

  _computeTeamSurprise(teamStats) {
    const result = {}
    for (const [team, stats] of Object.entries(teamStats)) {
      const h = stats.home
      const a = stats.away
      const t = stats.total
      const hTotal = h.wins + h.draws + h.losses
      const aTotal = a.wins + a.draws + a.losses
      const tTotal = t.wins + t.draws + t.losses

      result[team] = {
        homeWinRate: hTotal > 0 ? +((h.wins / hTotal) * 100).toFixed(1) : 0,
        homeDrawRate: hTotal > 0 ? +((h.draws / hTotal) * 100).toFixed(1) : 0,
        homeLossRate: hTotal > 0 ? +((h.losses / hTotal) * 100).toFixed(1) : 0,
        awayWinRate: aTotal > 0 ? +((a.wins / aTotal) * 100).toFixed(1) : 0,
        awayDrawRate: aTotal > 0 ? +((a.draws / aTotal) * 100).toFixed(1) : 0,
        awayLossRate: aTotal > 0 ? +((a.losses / aTotal) * 100).toFixed(1) : 0,
        totalMatches: tTotal,
      }
    }
    return result
  }

  getSurpriseStats(teamName) {
    this.load()
    if (!this.surpriseRates) this.computeSurpriseRates()

    const norm = (teamName || '').toLowerCase().trim()
    const stats = this.surpriseRates?.teamStats?.[norm]

    return {
      global: {
        drawRate: this.surpriseRates?.globalDrawRate || 33,
        homeWinRate: this.surpriseRates?.globalHomeWinRate || 45,
        awayWinRate: this.surpriseRates?.globalAwayWinRate || 22,
        sampleSize: this.surpriseRates?.totalMatches || 0,
      },
      team: stats || null,
      interpretation: stats
        ? `Sur ${stats.totalMatches} matchs historiques: ${stats.homeWinRate}% victoires domicile, ${stats.homeDrawRate}% nuls, ${stats.homeLossRate}% défaites`
        : 'Pas assez de données historiques pour cette équipe',
    }
  }

  getConcoursCount() {
    this.load()
    return this.historicalData?.length || 0
  }
}

export = new PromosportSurpriseService()
