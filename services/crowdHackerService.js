const fs = require('fs')
const path = require('path')
const logger = require('../core/logger')

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
    const tunisianPath = path.join(__dirname, '..', 'data', 'tunisian_vote_history.json')
    if (!fs.existsSync(tunisianPath)) return this.getDefaultProfile()

    const data = JSON.parse(fs.readFileSync(tunisianPath, 'utf-8'))
    const profile = {
      promosportAccuracy: { '1': { correct: 0, total: 0 }, 'X': { correct: 0, total: 0 }, '2': { correct: 0, total: 0 } },
      modelVersusPromosport: { agree: { correct: 0, total: 0, pct: 0 }, disagree: { correct: 0, total: 0, pct: 0 } },
      promosportBiasByConfidence: [],
      contrarianOpportunities: [],
      totalMatches: 0,
      promosportOverallAccuracy: 0,
    }

    for (const m of data) {
      if (!['1', 'X', '2'].includes(m.result)) continue
      profile.totalMatches++

      const p1 = m.vote1 || 0
      const px = m.voteX || 0
      const p2 = m.vote2 || 0
      const totalVotes = p1 + px + p2
      if (totalVotes === 0) continue

      const promosportPick = p1 >= px && p1 >= p2 ? '1' : (p2 >= px && p2 >= p1 ? '2' : 'X')
      const promosportProb = Math.max(p1, px, p2) / (totalVotes || 1)

      // Model pick using crowd algorithm rules
      const picks = [
        { label: 'X', pct: px },
        { label: '1', pct: p1 },
        { label: '2', pct: p2 },
      ]
      picks.sort((a, b) => b.pct - a.pct)
      const crowdFav = picks[0].label
      const favPct = picks[0].pct

      // Algorithme gagnant v2 — 2452 matchs analysés
      let modelPick = null
      if (crowdFav === '1' && favPct >= 55) {
        modelPick = '1'
      } else if (crowdFav === '2' && favPct >= 60) {
        modelPick = '2'
      }

      if (modelPick) {
        const agree = modelPick === promosportPick
        if (agree) {
          profile.modelVersusPromosport.agree.total++
          if (modelPick === m.result) profile.modelVersusPromosport.agree.correct++
        } else {
          profile.modelVersusPromosport.disagree.total++
          if (modelPick === m.result) profile.modelVersusPromosport.disagree.correct++

          if (promosportProb > 0.50) {
            profile.contrarianOpportunities.push({
              concours: m.grid,
              match: `${m.home} vs ${m.away}`,
              result: m.result,
              promosportPick,
              promosportProb: +(promosportProb * 100).toFixed(1),
              modelPick,
              modelProb: +(promosportProb * 100).toFixed(1),
              modelCorrect: modelPick === m.result,
            })
          }
        }

        const confBin = promosportProb >= 0.80 ? '80+' : (promosportProb >= 0.65 ? '65-80' : (promosportProb >= 0.50 ? '50-65' : '<50'))
        let biasBin = profile.promosportBiasByConfidence.find(b => b.bin === confBin)
        if (!biasBin) {
          biasBin = { bin: confBin, correct: 0, total: 0, promosportAccuracy: 0, modelAccuracy: 0, modelCorrect: 0, modelTotal: 0 }
          profile.promosportBiasByConfidence.push(biasBin)
        }
        biasBin.modelTotal++
        if (modelPick === m.result) biasBin.modelCorrect++
      }

      if (promosportPick === m.result) {
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
      if (promosportPick === m.result) biasBin.correct++
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

    // Compute tunisianCrowd section
    const byBin = {}
    let crowdRight = 0
    for (const m of data) {
      if (!['1', 'X', '2'].includes(m.result)) continue
      const picks = [
        { label: '1', pct: m.vote1 || 0 },
        { label: 'X', pct: m.voteX || 0 },
        { label: '2', pct: m.vote2 || 0 },
      ]
      picks.sort((a, b) => b.pct - a.pct)
      const crowdFav = picks[0].label
      const favPct = picks[0].pct
      const correct = crowdFav === m.result

      const bin = Math.floor(favPct / 10) * 10
      if (!byBin[bin]) byBin[bin] = { right: 0, total: 0 }
      byBin[bin].total++
      if (correct) byBin[bin].right++

      if (correct) crowdRight++
    }

    const weak = Object.entries(byBin).filter(([k]) => parseInt(k) < 70)
      .reduce((s, [, d]) => ({ r: s.r + d.right, t: s.t + d.total }), { r: 0, t: 0 })

    const strong = Object.entries(byBin).filter(([k]) => parseInt(k) >= 70)
      .reduce((s, [, d]) => ({ r: s.r + d.right, t: s.t + d.total }), { r: 0, t: 0 })

    profile.tunisianCrowd = {
      totalMatches: profile.totalMatches,
      crowdRight,
      crowdWrong: profile.totalMatches - crowdRight,
      crowdAccuracy: +(crowdRight / profile.totalMatches * 100).toFixed(1),
      byConfidence: Object.entries(byBin)
        .sort((a, b) => a[0] - b[0])
        .map(([bin, data]) => ({
          bin: `${bin}-${parseInt(bin) + 9}%`,
          total: data.total,
          right: data.right,
          accuracy: +(data.right / data.total * 100).toFixed(1),
        })),
      gridsAnalyzed: [...new Set(data.map(m => m.grid))].sort(),
      insight: {
        weakConfidence_under70: {
          accuracy: weak.t > 0 ? +(weak.r / weak.t * 100).toFixed(1) : 0,
          action: "CONTRARIAN - prendre l'opposé du favori",
        },
        strongConfidence_70plus: {
          accuracy: strong.t > 0 ? +(strong.r / strong.t * 100).toFixed(1) : 0,
          action: 'SUIVRE la foule (prudence)',
        },
      },
      lastUpdated: new Date().toISOString(),
    }

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

    // Tunisian crowd signal (real public vote data from promosport-pronostic.com)
    const tunisianCrowd = this.getTunisianCrowdSignal(matchData)

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
      tunisianCrowd,
    }
  }

  getTunisianCrowdSignal(matchData) {
    if (!matchData.publicVote && !matchData.homeWinProbability) return null

    let p1, px, p2

    if (matchData.publicVote) {
      p1 = matchData.publicVote.p1
      px = matchData.publicVote.px
      p2 = matchData.publicVote.p2
    } else {
      const total = matchData.homeWinProbability + matchData.drawProbability + matchData.awayWinProbability
      p1 = +(matchData.homeWinProbability / total * 100).toFixed(0)
      px = +(matchData.drawProbability / total * 100).toFixed(0)
      p2 = +(matchData.awayWinProbability / total * 100).toFixed(0)
    }

    const picks = [
      { label: '1', pct: p1 },
      { label: 'X', pct: px },
      { label: '2', pct: p2 },
    ]
    picks.sort((a, b) => b.pct - a.pct)
    const crowdFav = picks[0].label
    const favPct = picks[0].pct

    // Historical accuracy of Tunisian crowd at this confidence level (from 71 matches)
    const bin = Math.floor(favPct / 10) * 10
    const crowdAccByBin = {
      30: 50.0, 40: 42.9, 50: 37.1,
      60: 77.8, 70: 50.0, 80: 50.0, 90: 100.0,
    }
    const crowdAccuracy = bin <= 30 ? 50.0 : (crowdAccByBin[bin] ?? 46.5)

    const modelPick = matchData.predictedWinner
      ? (matchData.predictedWinner === 'home' ? '1' : matchData.predictedWinner === 'away' ? '2' : 'X')
      : null

    const modelAgreesWithCrowd = modelPick === crowdFav
    const contrarianSignal = modelPick && !modelAgreesWithCrowd && favPct < 70
      ? { type: 'STRONG_CONTRARIAN', reason: `Crowd only ${favPct}% on ${crowdFav} (historically ${crowdAccuracy}% accurate)` }
      : null

    return {
      crowdFav,
      favPct,
      p1, px, p2,
      crowdAccuracy,
      modelAgreesWithCrowd,
      contrarianSignal,
      recommendation: favPct < 70
        ? `Favori foule à ${favPct}% — historiquement ${crowdAccuracy}% correct. Considérer l'inverse.`
        : `Favori foule à ${favPct}% — fiable dans ${crowdAccuracy}% des cas.`,
    }
  }

  /**
   * Analyse anti-piège public : détecte quand le public se trompe
   * et recommande un pick contrarian.
   */
  detectPublicTrap(matchData) {
    const p1 = matchData.homeWinProbability || (matchData.probs?.h / 100) || 0.33
    const px = matchData.drawProbability || (matchData.probs?.x / 100) || 0.33
    const p2 = matchData.awayWinProbability || (matchData.probs?.a / 100) || 0.34

    const total = p1 + px + p2
    const norm = (v) => v / total

    const np1 = norm(p1), npx = norm(px), np2 = norm(p2)
    const picks = [
      { v: '1', pct: np1 },
      { v: 'X', pct: npx },
      { v: '2', pct: np2 },
    ]
    picks.sort((a, b) => b.pct - a.pct)
    const publicFav = picks[0].v
    const publicFavPct = picks[0].pct

    const mlP1 = matchData.mlProbs?.h / 100 || matchData.p1 || np1
    const mlPX = matchData.mlProbs?.x / 100 || matchData.px || npx
    const mlP2 = matchData.mlProbs?.a / 100 || matchData.p2 || np2

    const mlPicks = [
      { v: '1', pct: mlP1 },
      { v: 'X', pct: mlPX },
      { v: '2', pct: mlP2 },
    ]
    mlPicks.sort((a, b) => b.pct - a.pct)
    const mlFav = mlPicks[0].v

    // Detecter les pièges
    const isTrap = publicFavPct > 0.50 && mlFav !== publicFav
    const isAwayTrap = publicFav === '2' && publicFavPct > 0.50 && mlFav !== '2'
    const isHomeTrap = publicFav === '1' && publicFavPct > 0.50 && mlFav !== '1'

    // Recommandation contrarian
    let contrarianPick = null
    let reason = null
    if (isTrap) {
      contrarianPick = mlFav
      reason = `Le public est à ${(publicFavPct*100).toFixed(0)}% sur ${publicFav} mais le ML préfère ${mlFav}. Piège probable.`
    } else if (publicFavPct > 0.55 && mlFav === publicFav) {
      // ML agree with public but public is historically unreliable at high confidence
      contrarianPick = picks[1].v
      reason = `Public+ML d'accord sur ${publicFav} (${(publicFavPct*100).toFixed(0)}%) — Risque de piège, couvrir ${picks[1].v}`
    }

    return {
      publicFav,
      publicFavPct: +(publicFavPct * 100).toFixed(0),
      mlFav,
      isTrap,
      isAwayTrap,
      isHomeTrap,
      contrarianPick,
      reason,
      recommendation: isTrap
        ? `🔥 CONTRARIAN: Prendre ${contrarianPick} au lieu de ${publicFav} (public: ${(publicFavPct*100).toFixed(0)}%)`
        : (publicFavPct > 0.55
            ? `⚠️ PRUDENCE: Foule à ${(publicFavPct*100).toFixed(0)}% sur ${publicFav}, envisager double chance`
            : `✅ Conforme: foule dispersée, suivre ML`),
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
