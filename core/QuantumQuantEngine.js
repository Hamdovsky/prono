const StatisticalEngine = require('./services/StatisticalEngine')
const MomentumEngine = require('./services/MomentumEngine')

const LEAGUE_PROFILES = {
  attack:
    /bundesliga|netherlands|eredivisie|iceland|women|brazil|portugal|belgium|jupiler|austria|swiss|liga portugal/i,
  defense: /serie a|italy|ligue 2|argentina|greece|tunisia|morocco|egypt|saudi|qatar/i,
}

function getLeagueProfile(league) {
  if (!league) return 'balanced'
  if (LEAGUE_PROFILES.attack.test(league)) return 'attack'
  if (LEAGUE_PROFILES.defense.test(league)) return 'defense'
  return 'balanced'
}

function getTeamStyle(xgH, xgA, m) {
  let attacking = 0
  if (m.home_avg_scored > 1.5 || m.away_avg_scored > 1.5) attacking++
  if (m.home_avg_scored < 1.0 || m.away_avg_scored < 1.0) attacking--
  if (xgH + xgA > 3.0) attacking++
  if (xgH + xgA < 2.0) attacking--
  return attacking
}

function getWeatherImpact(m) {
  const desc = (m.weather_desc || '').toLowerCase()
  if (
    desc.includes('rain') ||
    desc.includes('pluie') ||
    desc.includes('storm') ||
    desc.includes('wind') ||
    desc.includes('vent')
  )
    return -1
  return 0
}

class QuantumQuantEngine {
  _teamHash(name) {
    if (!name) return 0
    let h = 0
    for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0
    return h
  }

  analyze(m, xgH, xgA) {
    // Team-name based dispersion, only when data is insufficient (gated so that
    // matches with real odds produce deterministic, data-driven picks)
    const tHash = this._teamHash(m.homeTeam) ^ this._teamHash(m.awayTeam)
    const dispersion = m.insufficient_data ? (tHash % 140) / 1000 - 0.07 : 0
    const gmParams = StatisticalEngine.getGoalModelParams(m.league)
    const { h: xgHadj, a: xgAadj } = StatisticalEngine.applyGamma(
      Math.max(0.3, xgH + dispersion),
      Math.max(0.3, xgA - dispersion),
      gmParams.gamma
    )
    const probs = StatisticalEngine.calculatePoissonProbs(xgHadj, xgAadj, m, {
      rho: gmParams.rho,
      gamma: gmParams.gamma,
    })
    const markets = this._generateMarkets(probs, m)
    const profile = getLeagueProfile(m.league)
    const teamStyle = getTeamStyle(xgHadj, xgAadj, m)
    const weatherImpact = getWeatherImpact(m)
    const ranked = this._rankMarkets(markets, m, { profile, teamStyle, weatherImpact })

    const mktStrength = ranked.market_strength || 'NORMAL'

    return {
      markets,
      main_pick: ranked.main.val,
      secondary_pick: ranked.secondary.label,
      ev_score: ranked.secondary.ev.toFixed(2),
      edge_score: ranked.secondary.edge.toFixed(2),
      risk_label: this._getRiskLabel(ranked.main.prob),
      expected_score: StatisticalEngine.findMostProbableScore(xgHadj, xgAadj, {
        rho: gmParams.rho,
        gamma: gmParams.gamma,
      }),
      confidence:
        m.insufficient_data === 1
          ? Math.round(ranked.main.prob * 50) // Forte pénalité si aucune donnée (odds+xG+forme absents)
          : Math.round(ranked.main.prob * 100),
      bsd_boosted: ranked.bsd_boosted || false,
      market_strength: mktStrength,
      momentum: {
        home: MomentumEngine.getTrend(m.homeTeam),
        away: MomentumEngine.getTrend(m.awayTeam),
      },
      all_picks: ranked.all.slice(0, 4),
      probs: {
        btts: Math.round(probs.btts.yes * 100),
        over25: Math.round(probs.over25 * 100),
        ht_goal: Math.round(probs.ht_goal * 100),
      },
      league_profile: profile,
      context: {
        teamStyle: teamStyle > 0 ? 'attacking' : teamStyle < 0 ? 'defensive' : 'neutral',
        weatherImpact,
      },
    }
  }

  _generateMarkets(p, m) {
    const ht = p.first_half
    const calcEV = (prob, odds) => prob * (odds || 2.0) - 1

    const markets = {
      match_result: {
        1: { prob: p.win.home, odds: m.odds_home, ev: calcEV(p.win.home, m.odds_home) },
        X: { prob: p.win.draw, odds: m.odds_draw, ev: calcEV(p.win.draw, m.odds_draw) },
        2: { prob: p.win.away, odds: m.odds_away, ev: calcEV(p.win.away, m.odds_away) },
      },
      over_under: {
        'O1.5': { prob: p.over15, odds: 1.4, ev: calcEV(p.over15, 1.4) },
        'U1.5': { prob: p.under15, odds: 2.6, ev: calcEV(p.under15, 2.6) },
        'O2.5': {
          prob: p.over25,
          odds: m.odds_over25 || 1.85,
          ev: calcEV(p.over25, m.odds_over25 || 1.85),
        },
        'U2.5': {
          prob: p.under25,
          odds: m.odds_under25 || 1.95,
          ev: calcEV(p.under25, m.odds_under25 || 1.95),
        },
        'O3.5': { prob: p.over35, odds: 3.2, ev: calcEV(p.over35, 3.2) },
        'U3.5': { prob: p.under35, odds: 1.45, ev: calcEV(p.under35, 1.45) },
        'O4.5': { prob: p.over45, odds: 6.0, ev: calcEV(p.over45, 6.0) },
        'U4.5': { prob: p.under45, odds: 1.12, ev: calcEV(p.under45, 1.12) },
      },
      btts: {
        YES: {
          prob: p.btts.yes,
          odds: m.odds_btts_yes || 1.8,
          ev: calcEV(p.btts.yes, m.odds_btts_yes || 1.8),
        },
        NO: {
          prob: p.btts.no,
          odds: m.odds_btts_no || 2.05,
          ev: calcEV(p.btts.no, m.odds_btts_no || 2.05),
        },
      },
      double_chance: {
        '1X': { prob: p.dc['1X'], odds: 1.3, ev: calcEV(p.dc['1X'], 1.3) },
        X2: { prob: p.dc['X2'], odds: 1.6, ev: calcEV(p.dc['X2'], 1.6) },
        12: { prob: p.dc['12'], odds: 1.25, ev: calcEV(p.dc['12'], 1.25) },
      },
      first_half: {
        'O0.5': { prob: ht.goal_yes, odds: 1.5, ev: calcEV(ht.goal_yes, 1.5) },
        'O1.5': { prob: ht.ou15, odds: 3.5, ev: calcEV(ht.ou15, 3.5) },
        BTTS: { prob: ht.btts, odds: 6.0, ev: calcEV(ht.btts, 6.0) },
      },
    }

    return markets
  }

  _rankMarkets(markets, m, ctx = {}) {
    const profile = ctx.profile || 'balanced'
    const teamStyle = ctx.teamStyle || 0
    const weatherImpact = ctx.weatherImpact || 0
    const ranked = []

    for (const [cat, choices] of Object.entries(markets)) {
      for (const [val, data] of Object.entries(choices)) {
        const prob = data.prob
        const odds = data.odds || 0
        const impliedProb = odds > 0 ? 1 / odds : 0
        const edge = impliedProb > 0 ? prob - impliedProb : 0
        const ev = odds > 0 ? prob * odds - 1 : 0

        let smartScore = prob * 50 + edge * 150 + ev * 30

        // ── CONTEXTUAL BIAS ──
        // League profile: attack leagues favor O2.5, HT goals, BTTS; defense leagues favor U2.5, BTTS No, DC
        if (profile === 'attack') {
          if (cat === 'first_half') smartScore *= 1.25
          if (val === 'O2.5' || val === 'YES') smartScore *= 1.15
        } else if (profile === 'defense') {
          if (val === 'U2.5' || val === 'NO') smartScore *= 1.2
          if (cat === 'double_chance') smartScore *= 1.1
        }

        // Team style: attacking teams favor HT goals, BTTS; defensive teams favor U2.5
        if (teamStyle > 0) {
          if (cat === 'first_half') smartScore *= 1.2
          if (val === 'YES' || val === 'O2.5') smartScore *= 1.1
        } else if (teamStyle < 0) {
          if (val === 'U2.5' || val === 'NO') smartScore *= 1.15
        }

        // Weather: rain/wind → fewer goals → U2.5, BTTS No get boosted
        if (weatherImpact < 0) {
          if (val === 'U2.5' || val === 'NO') smartScore *= 1.2
          if (cat === 'first_half') smartScore *= 0.85
        }

        ranked.push({
          cat,
          val,
          prob,
          odds,
          ev,
          edge,
          smartScore,
          label: this._getLabel(cat, val),
        })
      }
    }

    const matchResultMarkets = ranked.filter((r) => r.cat === 'match_result')
    const sortedMR = matchResultMarkets.sort((a, b) => b.prob - a.prob)
    const best1X2 = sortedMR[0]

    // Smart MAIN pick: DC if it beats best 1X2 by >20 points
    const dcMarkets = ranked.filter((r) => r.cat === 'double_chance')
    const bestDC = dcMarkets.sort((a, b) => b.prob - a.prob)[0]
    let mainPick = best1X2
    if (bestDC && best1X2 && bestDC.prob - best1X2.prob > 0.2 && bestDC.prob > 0.6) {
      mainPick = { ...bestDC, _promotedFrom: 'double_chance' }
    }
    // HT O0.5 if it's very strong and 1X2 is weak
    const htMarkets = ranked.filter((r) => r.cat === 'first_half' && r.val === 'O0.5')
    const bestHT = htMarkets[0]
    if (bestHT && best1X2 && bestHT.prob - best1X2.prob > 0.25 && bestHT.prob > 0.7) {
      mainPick = { ...bestHT, _promotedFrom: 'first_half' }
    }

    const secondaryPool = ranked.filter((r) => r.label !== mainPick.label && r.prob > 0.3)

    const secondaryPicks = secondaryPool.sort((a, b) => b.smartScore - a.smartScore)
    const bestValue = secondaryPicks[0] || mainPick
    const isMassive = bestValue.edge > 0.12 && bestValue.prob > 0.5
    let signalStrength = Math.min(100, Math.round(bestValue.edge * 400 + bestValue.prob * 40))
    let bsd_boosted = false
    if (m.bsd_prediction && mainPick) {
      const bsdPicks = { 1: '1', HOME: '1', X: 'X', DRAW: 'X', 2: '2', AWAY: '2' }
      const bsdWinner = bsdPicks[m.bsd_prediction.trim().toUpperCase()]
      const qqWinner = mainPick.val
      if (bsdWinner && qqWinner && bsdWinner === qqWinner) {
        mainPick.prob = Math.min(0.99, mainPick.prob * 1.15)
        signalStrength = Math.min(100, signalStrength + 15)
        bsd_boosted = true
      }
    }

    const marketStrength = signalStrength >= 80 ? 'HIGH' : signalStrength >= 50 ? 'NORMAL' : 'LOW'

    return {
      main: mainPick,
      secondary: bestValue,
      all: secondaryPicks,
      massive_edge: isMassive,
      signal_strength: signalStrength,
      market_strength: marketStrength,
      bsd_boosted: bsd_boosted,
    }
  }

  _getLabel(cat, val) {
    const catNames = {
      match_result: '',
      over_under: 'O/U ',
      btts: 'BTTS: ',
      double_chance: 'DC: ',
      first_half: 'HT: ',
      handicap: 'H: ',
    }
    return `${catNames[cat] || ''}${val}`
  }

  _getRiskLabel(prob) {
    if (prob > 0.75) return 'SAFE'
    if (prob > 0.6) return 'STABLE'
    if (prob > 0.45) return 'MODERATE'
    return 'RISKY'
  }
}

module.exports = new QuantumQuantEngine()
