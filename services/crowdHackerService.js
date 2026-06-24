const fs = require('fs')
const path = require('path')
const logger = require('../core/logger')
const promosportSurpriseService = require('./promosportSurpriseService')

class CrowdHackerService {
  constructor() {
    this.promosportBiasProfile = null
    this.lastLoaded = 0
    this.TTL = 86400000
  }

  loadProfile() {
    if (this.promosportBiasProfile && Date.now() - this.lastLoaded < this.TTL) return
    try {
      const profilePath = path.join(__dirname, '..', 'data', 'crowd_profile.json')
      if (fs.existsSync(profilePath)) {
        this.promosportBiasProfile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'))
        this.lastLoaded = Date.now()
        logger.info(`[CROWD-HACKER] Profile loaded from disk`)
        return
      }
    } catch (e) {
      logger.warn(`[CROWD-HACKER] Could not load profile: ${e.message}`)
    }

    this.promosportBiasProfile = this.buildProfile()
    try {
      const profilePath = path.join(__dirname, '..', 'data', 'crowd_profile.json')
      fs.writeFileSync(profilePath, JSON.stringify(this.promosportBiasProfile, null, 2))
      logger.info(`[CROWD-HACKER] Profile built and saved`)
    } catch (e) {
      logger.warn(`[CROWD-HACKER] Could not save profile: ${e.message}`)
    }
    this.lastLoaded = Date.now()
  }

  buildProfile() {
    promosportSurpriseService.computeSurpriseRates()
    const histPath = path.join(__dirname, '..', 'data', 'promosport_historical_results.json')
    if (!fs.existsSync(histPath)) return this.getDefaultProfile()

    const data = JSON.parse(fs.readFileSync(histPath, 'utf-8'))
    const profile = {
      promosportAccuracy: { '1': { correct: 0, total: 0 }, 'X': { correct: 0, total: 0 }, '2': { correct: 0, total: 0 } },
      modelVersusPromosport: { agree: { correct: 0, total: 0, pct: 0 }, disagree: { correct: 0, total: 0, pct: 0 } },
      promosportBiasByConfidence: [],
      contrarianOpportunities: [],
      totalMatches: 0,
      promosportOverallAccuracy: 0,
    }

    for (const c of data) {
      for (const m of c.matches) {
        if (!['1', 'X', '2'].includes(m.res)) continue
        profile.totalMatches++

        const homeStat = promosportSurpriseService.getSurpriseStats(m.home)
        const awayStat = promosportSurpriseService.getSurpriseStats(m.away)
        const hRate = homeStat?.team?.homeWinRate != null ? homeStat.team.homeWinRate / 100 : 0.424
        const aRate = awayStat?.team?.awayWinRate != null ? awayStat.team.awayWinRate / 100 : 0.317
        const hRateL = homeStat?.team?.homeLossRate != null ? homeStat.team.homeLossRate / 100 : 0.317
        const aRateL = awayStat?.team?.awayLossRate != null ? awayStat.team.awayLossRate / 100 : 0.424

        let p1 = hRate * 0.6 + aRateL * 0.4
        let px = (hRate != null ? homeStat.team.homeDrawRate / 100 : 0.259) * 0.5 + (aRate != null ? awayStat.team.awayDrawRate / 100 : 0.259) * 0.5
        let p2 = hRateL * 0.6 + aRate * 0.4
        const total = p1 + px + p2
        p1 /= total; px /= total; p2 /= total

        const modelPick = p1 >= px && p1 >= p2 ? '1' : (p2 >= px && p2 >= p1 ? '2' : 'X')
        const modelProb = Math.max(p1, px, p2)

        const promosportP1 = m.homeWinProbability ? (m.homeWinProbability > 1 ? m.homeWinProbability / 100 : m.homeWinProbability) : null
        const promosportPX = m.drawProbability ? (m.drawProbability > 1 ? m.drawProbability / 100 : m.drawProbability) : null
        const promosportP2 = m.awayWinProbability ? (m.awayWinProbability > 1 ? m.awayWinProbability / 100 : m.awayWinProbability) : null

        const hasPromosport = promosportP1 != null && promosportPX != null && promosportP2 != null
        if (!hasPromosport) continue

        const promosportPick = promosportP1 >= promosportPX && promosportP1 >= promosportP2 ? '1'
          : (promosportP2 >= promosportPX && promosportP2 >= promosportP1 ? '2' : 'X')
        const promosportProb = Math.max(promosportP1, promosportPX, promosportP2)

        const agree = modelPick === promosportPick

        if (agree) {
          profile.modelVersusPromosport.agree.total++
          if (modelPick === m.res) profile.modelVersusPromosport.agree.correct++
        } else {
          profile.modelVersusPromosport.disagree.total++
          if (modelPick === m.res) profile.modelVersusPromosport.disagree.correct++

          if (promosportProb > 0.50) {
            profile.contrarianOpportunities.push({
              concours: c.no,
              match: `${m.home} vs ${m.away}`,
              result: m.res,
              promosportPick,
              promosportProb: +(promosportProb * 100).toFixed(1),
              modelPick,
              modelProb: +(modelProb * 100).toFixed(1),
              modelCorrect: modelPick === m.res,
            })
          }
        }

        if (promosportPick === m.res) {
          profile.promosportAccuracy[promosportPick].correct++
        }
        profile.promosportAccuracy[promosportPick].total++

        const confBin = promosportProb >= 0.80 ? '80+' : (promosportProb >= 0.65 ? '65-80' : (promosportProb >= 0.50 ? '50-65' : '<50'))
        let biasBin = profile.promosportBiasByConfidence.find(b => b.bin === confBin)
        if (!biasBin) {
          biasBin = { bin: confBin, correct: 0, total: 0, promosportAccuracy: 0, modelAccuracy: 0, modelCorrect: 0, modelTotal: 0 }
          profile.promosportBiasByConfidence.push(biasBin)
        }
        biasBin.total++
        if (promosportPick === m.res) biasBin.correct++
        biasBin.modelTotal++
        if (modelPick === m.res) biasBin.modelCorrect++
      }
    }

    for (const [pick, acc] of Object.entries(profile.promosportAccuracy)) {
      acc.rate = acc.total > 0 ? +(acc.correct / acc.total * 100).toFixed(1) : 0
    }
    for (const bin of profile.promosportBiasByConfidence) {
      bin.promosportAccuracy = bin.total > 0 ? +(bin.correct / bin.total * 100).toFixed(1) : 0
      bin.modelAccuracy = bin.modelTotal > 0 ? +(bin.modelCorrect / bin.modelTotal * 100).toFixed(1) : 0
      bin.gap = +(bin.modelAccuracy - bin.promosportAccuracy).toFixed(1)
    }
    profile.promosportOverallAccuracy = profile.totalMatches > 0
      ? +((profile.promosportAccuracy['1'].correct + profile.promosportAccuracy['X'].correct + profile.promosportAccuracy['2'].correct) / profile.totalMatches * 100).toFixed(1)
      : 0
    profile.modelVersusPromosport.agree.pct = profile.modelVersusPromosport.agree.total > 0
      ? +(profile.modelVersusPromosport.agree.correct / profile.modelVersusPromosport.agree.total * 100).toFixed(1) : 0
    profile.modelVersusPromosport.disagree.pct = profile.modelVersusPromosport.disagree.total > 0
      ? +(profile.modelVersusPromosport.disagree.correct / profile.modelVersusPromosport.disagree.total * 100).toFixed(1) : 0
    profile.contrarianOpportunities.sort((a, b) => b.promosportProb - a.promosportProb)
    profile.contrarianHitRate = profile.contrarianOpportunities.length > 0
      ? +(profile.contrarianOpportunities.filter(o => o.modelCorrect).length / profile.contrarianOpportunities.length * 100).toFixed(1)
      : 0

    return profile
  }

  getContrarianSignal(matchData) {
    this.loadProfile()
    if (!this.promosportBiasProfile) return null

    const promosportPick = matchData.homeWinProbability
      ? (matchData.homeWinProbability >= matchData.drawProbability && matchData.homeWinProbability >= matchData.awayWinProbability ? '1'
        : (matchData.awayWinProbability >= matchData.drawProbability && matchData.awayWinProbability >= matchData.homeWinProbability ? '2' : 'X'))
      : null

    if (!promosportPick) return null

    const hasHistoricalEdge = this.promosportBiasProfile.modelVersusPromosport.disagree.pct > 40
    const biasBin = this.promosportBiasProfile.promosportBiasByConfidence.find(b => {
      const prob = matchData.homeWinProbability || 0.33
      if (b.bin === '80+' && prob >= 0.80) return true
      if (b.bin === '65-80' && prob >= 0.65 && prob < 0.80) return true
      if (b.bin === '50-65' && prob >= 0.50 && prob < 0.65) return true
      if (b.bin === '<50' && prob < 0.50) return true
      return false
    })

    const modelEdge = biasBin && biasBin.modelAccuracy > biasBin.promosportAccuracy

    return {
      promosportPick,
      promosportAccuracy: this.promosportBiasProfile.promosportOverallAccuracy,
      modelVersusPromosport: {
        agreeAccuracy: this.promosportBiasProfile.modelVersusPromosport.agree.pct,
        disagreeAccuracy: this.promosportBiasProfile.modelVersusPromosport.disagree.pct,
        totalContrarianHits: this.promosportBiasProfile.contrarianOpportunities.length,
        contrarianHitRate: this.promosportBiasProfile.contrarianHitRate,
      },
      historicalEdge: hasHistoricalEdge,
      modelAdvantage: modelEdge ? +(biasBin.modelAccuracy - biasBin.promosportAccuracy).toFixed(1) : 0,
    }
  }

  getDefaultProfile() {
    return {
      promosportAccuracy: { '1': { correct: 0, total: 0, rate: 0 }, 'X': { correct: 0, total: 0, rate: 0 }, '2': { correct: 0, total: 0, rate: 0 } },
      modelVersusPromosport: { agree: { correct: 0, total: 0, pct: 0 }, disagree: { correct: 0, total: 0, pct: 0 } },
      promosportBiasByConfidence: [],
      contrarianOpportunities: [],
      totalMatches: 0,
      promosportOverallAccuracy: 0,
      contrarianHitRate: 0,
    }
  }
}

module.exports = new CrowdHackerService()
