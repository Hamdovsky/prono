const fs = require('fs')
const path = require('path')
const logger = require('../core/logger')
const promosportSurpriseService = require('./promosportSurpriseService')

class CompetitionAnalyzer {
  constructor() {
    this.profile = null
    this.dataPath = path.join(__dirname, '..', 'data', 'competition_profile.json')
  }

  analyze() {
    if (this.profile) return this.profile
    promosportSurpriseService.computeSurpriseRates()
    const histPath = path.join(__dirname, '..', 'data', 'promosport_historical_results.json')
    if (!fs.existsSync(histPath)) {
      logger.warn('[COMP-ANALYZER] No historical data')
      return this.getEmptyProfile()
    }
    const data = JSON.parse(fs.readFileSync(histPath, 'utf-8'))

    const stats = {
      totalConcours: data.length,
      totalMatches: 0,
      resultDistribution: { '1': 0, 'X': 0, '2': 0 },
      byIndex: Array(13).fill(null).map(() => ({ '1': 0, 'X': 0, '2': 0, total: 0 })),
      bySurpriseBucket: { underdog: 0, favorite: 0, balanced: 0 },
      concoursDifficulty: [],
      trapPatterns: [],
      fav1Win: 0, fav1Total: 0,
      fav2Win: 0, fav2Total: 0,
      homeFavRate: 0,
      surpriseRate: 0,
      surpriseCount: 0,
    }

    for (const c of data) {
      let cFavWin = 0
      for (const m of c.matches) {
        if (!['1', 'X', '2'].includes(m.res)) continue
        stats.totalMatches++
        const idx = parseInt(m.idx) - 1

        stats.resultDistribution[m.res]++
        if (idx >= 0 && idx < 13) stats.byIndex[idx][m.res]++
        if (idx >= 0 && idx < 13) stats.byIndex[idx].total++

        const homeStat = promosportSurpriseService.getSurpriseStats(m.home)
        const awayStat = promosportSurpriseService.getSurpriseStats(m.away)
        const hRate = homeStat?.team?.homeWinRate != null ? homeStat.team.homeWinRate / 100 : 0.424
        const aRate = awayStat?.team?.awayWinRate != null ? awayStat.team.awayWinRate / 100 : 0.317

        if (hRate > 0.50) {
          stats.fav1Total++
          if (m.res === '1') stats.fav1Win++
        }
        if (aRate > 0.50) {
          stats.fav2Total++
          if (m.res === '2') stats.fav2Win++
        }

        if (m.res !== '1' && hRate > 0.55) stats.surpriseCount++
        if (m.res !== '2' && aRate > 0.55) stats.surpriseCount++

        const diff = Math.abs(hRate - aRate)
        if (diff > 0.30) stats.bySurpriseBucket.favorite++
        else if (diff < 0.10) stats.bySurpriseBucket.balanced++
        else stats.bySurpriseBucket.underdog++
      }
      stats.concoursDifficulty.push({
        no: c.no,
        total: c.matches.filter(m => ['1','X','2'].includes(m.res)).length,
      })
    }

    stats.surpriseRate = +(stats.surpriseCount / stats.totalMatches * 100).toFixed(1)
    stats.homeFavRate = +(stats.fav1Total > 0 ? (stats.fav1Win / stats.fav1Total * 100) : 0).toFixed(1)

    stats.resultPct = {
      '1': +(stats.resultDistribution['1'] / stats.totalMatches * 100).toFixed(1),
      'X': +(stats.resultDistribution['X'] / stats.totalMatches * 100).toFixed(1),
      '2': +(stats.resultDistribution['2'] / stats.totalMatches * 100).toFixed(1),
    }

    stats.byIndexPct = stats.byIndex.map(b => ({
      total: b.total,
      '1': b.total > 0 ? +(b['1'] / b.total * 100).toFixed(1) : 0,
      'X': b.total > 0 ? +(b['X'] / b.total * 100).toFixed(1) : 0,
      '2': b.total > 0 ? +(b['2'] / b.total * 100).toFixed(1) : 0,
    }))

    const sorted = [...stats.concoursDifficulty].sort((a, b) => a.total - b.total)
    stats.hardestConcours = sorted.slice(0, 5)
    stats.easiestConcours = sorted.slice(-5).reverse()

    stats.surpriseByIndex = Array(13).fill(null).map(() => ({ total: 0, surprises: 0 }))
    for (const c of data) {
      for (const m of c.matches) {
        if (!['1', 'X', '2'].includes(m.res)) continue
        const idx = parseInt(m.idx) - 1
        if (idx < 0 || idx > 12) continue
        stats.surpriseByIndex[idx].total++
        const homeStat = promosportSurpriseService.getSurpriseStats(m.home)
        const awayStat = promosportSurpriseService.getSurpriseStats(m.away)
        const hRate = homeStat?.team?.homeWinRate != null ? homeStat.team.homeWinRate / 100 : 0.424
        const aRate = awayStat?.team?.awayWinRate != null ? awayStat.team.awayWinRate / 100 : 0.317
        if ((m.res !== '1' && hRate > 0.55) || (m.res !== '2' && aRate > 0.55)) {
          stats.surpriseByIndex[idx].surprises++
        }
      }
    }

    this.profile = stats
    fs.writeFileSync(this.dataPath, JSON.stringify(stats, null, 2))
    logger.info(`[COMP-ANALYZER] Profile saved (${stats.totalMatches} matches, ${stats.totalConcours} concours)`)
    return stats
  }

  getProfile() {
    if (!this.profile) this.analyze()
    return this.profile
  }

  getIndexTrapLevel(idx) {
    const p = this.getProfile()
    const s = p.surpriseByIndex[idx]
    if (!s || s.total === 0) return 0
    return s.surprises / s.total
  }

  getMatchIntel(homeTeam, awayTeam, idx) {
    const p = this.getProfile()
    const trapLvl = this.getIndexTrapLevel((idx || 1) - 1)
    const homeStat = promosportSurpriseService.getSurpriseStats(homeTeam)
    const awayStat = promosportSurpriseService.getSurpriseStats(awayTeam)
    const hRate = homeStat?.team?.homeWinRate != null ? homeStat.team.homeWinRate / 100 : null
    const aRate = awayStat?.team?.awayWinRate != null ? awayStat.team.awayWinRate / 100 : null

    let analysis = []
    if (trapLvl > 0.35) analysis.push(`⚠️ Index piégeux (#${idx}): ${(trapLvl*100).toFixed(0)}% de surprises`)
    if (hRate != null && hRate > 0.60) analysis.push(`🏠 Domicile solide (${(hRate*100).toFixed(0)}% de victoires)`)
    if (aRate != null && aRate > 0.40) analysis.push(`✈️ Extérieur compétitif (${(aRate*100).toFixed(0)}% de victoires)`)

    return {
      profile: {
        totalMatches: p.totalMatches,
        homeWinPct: p.resultPct['1'],
        drawPct: p.resultPct['X'],
        awayWinPct: p.resultPct['2'],
      },
      indexIntel: {
        position: idx,
        trapLevel: +(trapLvl * 100).toFixed(1),
        matchesAtThisIndex: p.surpriseByIndex[(idx || 1) - 1]?.total || 0,
      },
      analysis,
    }
  }

  getEmptyProfile() {
    return {
      totalConcours: 0, totalMatches: 0,
      resultDistribution: { '1': 0, 'X': 0, '2': 0 },
      byIndex: [], byIndexPct: [],
      surpriseRate: 0, homeFavRate: 0,
    }
  }
}

module.exports = new CompetitionAnalyzer()
