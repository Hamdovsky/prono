const logger = require('../core/logger')
const fbrefService = require('./fbrefService')
const statsbombService = require('./statsbombService')
const transfermarktService = require('./transfermarktService')
const database = require('../core/database')

const LEAGUE_MAP = {
  PL: { fbref: 'PL', transfermarkt: { slug: 'premier-league', id: 9 } },
  'La Liga': { fbref: 'LA_LIGA', transfermarkt: { slug: 'laliga', id: 12 } },
  'Serie A': { fbref: 'SERIE_A', transfermarkt: { slug: 'serie-a', id: 13 } },
  Bundesliga: { fbref: 'BUNDESLIGA', transfermarkt: { slug: 'bundesliga', id: 20 } },
  'Ligue 1': { fbref: 'LIGUE_1', transfermarkt: { slug: 'ligue-1', id: 16 } },
}

const TEAM_SLUGS = {
  'Manchester City': { slug: 'manchester-city', id: 281 },
  'Manchester United': { slug: 'manchester-united', id: 985 },
  Liverpool: { slug: 'liverpool', id: 31 },
  Arsenal: { slug: 'arsenal', id: 11 },
  Chelsea: { slug: 'chelsea', id: 631 },
  Tottenham: { slug: 'tottenham-hotspur', id: 148 },
  Newcastle: { slug: 'newcastle-united', id: 762 },
  'Aston Villa': { slug: 'aston-villa', id: 405 },
  'Real Madrid': { slug: 'real-madrid', id: 418 },
  Barcelona: { slug: 'barcelona', id: 131 },
  'Atletico Madrid': { slug: 'atletico-madrid', id: 13 },
  'Bayern Munich': { slug: 'bayern-munchen', id: 27 },
  'Borussia Dortmund': { slug: 'borussia-dortmund', id: 267 },
  'Paris Saint-Germain': { slug: 'paris-saint-germain', id: 583 },
  Marseille: { slug: 'olympique-marseille', id: 244 },
  'Inter Milan': { slug: 'inter-mailand', id: 46 },
  'AC Milan': { slug: 'ac-mailand', id: 5 },
  Juventus: { slug: 'juventus', id: 506 },
}

class ValueBetEnricher {
  constructor() {
    this.cache = new Map()
    this.CACHE_TTL = 30 * 60 * 1000
  }

  isAvailable() {
    return fbrefService.isAvailable() || transfermarktService.isAvailable()
  }

  _getCached(key) {
    const entry = this.cache.get(key)
    if (entry && Date.now() - entry.ts < this.CACHE_TTL) return entry.data
    return null
  }

  _setCache(key, data) {
    this.cache.set(key, { ts: Date.now(), data })
  }

  poissonProb(lambda, k) {
    if (lambda <= 0) return k === 0 ? 1 : 0
    let p = Math.exp(-lambda)
    for (let i = 1; i <= k; i++) p *= lambda / i
    return p
  }

  expectedScore(homeXG, awayXG) {
    const maxGoals = 10
    let pHome = 0,
      pDraw = 0,
      pAway = 0

    for (let h = 0; h <= maxGoals; h++) {
      for (let a = 0; a <= maxGoals; a++) {
        const prob = this.poissonProb(homeXG, h) * this.poissonProb(awayXG, a)
        if (h > a) pHome += prob
        else if (h === a) pDraw += prob
        else pAway += prob
      }
    }

    return { home: pHome, draw: pDraw, away: pAway }
  }

  probToOdds(prob) {
    if (!prob || prob <= 0) return 0
    return parseFloat((1 / prob).toFixed(2))
  }

  adjustForInjuries(baseXG, injuries) {
    if (!injuries || injuries.length === 0) return baseXG
    // Each key injury reduces xG by ~5%
    let adjustment = 0
    for (const inj of injuries) {
      if (['Striker', 'Attacking Midfield', 'Left Winger', 'Right Winger'].includes(inj.position)) {
        adjustment += 0.05
      } else if (['Centre-Back', 'Goalkeeper'].includes(inj.position)) {
        adjustment += 0.03
      } else {
        adjustment += 0.02
      }
    }
    return baseXG * (1 - Math.min(adjustment, 0.3))
  }

  adjustForValueGap(homeXG, awayXG, homeValue, awayValue) {
    if (!homeValue || !awayValue || homeValue === 0 || awayValue === 0) return { homeXG, awayXG }
    const ratio = homeValue / awayValue
    // If one team is significantly more valuable, boost their xG slightly
    const factor = Math.min(Math.max(ratio, 0.5), 2) // clamp between 0.5 and 2
    const adjustment = (factor - 1) * 0.08 // ±8% per 2x value gap
    return {
      homeXG: homeXG * (1 + adjustment),
      awayXG: awayXG * (1 - adjustment),
    }
  }

  async enrichMatch(match) {
    if (!match || !match.homeTeam || !match.awayTeam) return null

    const cacheKey = `enrich:${match.homeTeam}-${match.awayTeam}-${(match.date || '').slice(0, 10)}`
    const cached = this._getCached(cacheKey)
    if (cached) return cached

    const result = {
      match,
      homeXG: null,
      awayXG: null,
      fairOdds: null,
      marketOdds: null,
      valuePct: null,
      confidence: 'low',
      adjustmentFactors: [],
    }

    try {
      // 1. Get FBref stats for both teams (falls back to StatsBomb open-data —
      //    fbref.com is Cloudflare-blocked from datacenter IPs, StatsBomb is not)
      const leagueInfo = LEAGUE_MAP[match.league]
      if (leagueInfo && fbrefService.isAvailable()) {
        try {
          const allStats = await fbrefService.getTeamStats(leagueInfo.fbref)
          const homeStats = allStats.find(
            (s) =>
              match.homeTeam.toLowerCase().includes(s.team.toLowerCase()) ||
              s.team.toLowerCase().includes(match.homeTeam.toLowerCase())
          )
          const awayStats = allStats.find(
            (s) =>
              match.awayTeam.toLowerCase().includes(s.team.toLowerCase()) ||
              s.team.toLowerCase().includes(match.awayTeam.toLowerCase())
          )

          if (homeStats) {
            result.homeXG = homeStats.xG || null
            result.adjustmentFactors.push(`FBref home xG: ${homeStats.xG}`)
          }
          if (awayStats) {
            result.awayXG = awayStats.xG || null
            result.adjustmentFactors.push(`FBref away xG: ${awayStats.xG}`)
          }
        } catch (_) {
          // fbref blocked → fall through to StatsBomb
        }
      }
      if (!result.homeXG || !result.awayXG) {
        const [hs, as] = await Promise.all([
          statsbombService.getTeamXG(match.homeTeam, match.league),
          statsbombService.getTeamXG(match.awayTeam, match.league),
        ])
        if (hs && hs.xG && !result.homeXG) {
          result.homeXG = hs.xG
          result.adjustmentFactors.push(`StatsBomb home xG: ${hs.xG}`)
        }
        if (as && as.xG && !result.awayXG) {
          result.awayXG = as.xG
          result.adjustmentFactors.push(`StatsBomb away xG: ${as.xG}`)
        }
      }

      // Fallback: use league average xG if individual stats missing
      const avgXG = 1.35
      const homeXG = result.homeXG || avgXG
      const awayXG = result.awayXG || avgXG

      // 2. Get Transfermarkt data
      const homeTM = TEAM_SLUGS[match.homeTeam]
      const awayTM = TEAM_SLUGS[match.awayTeam]

      let homeValue = null,
        awayValue = null
      let homeInjuries = [],
        awayInjuries = []

      if (transfermarktService.isAvailable()) {
        if (homeTM) {
          try {
            const info = await transfermarktService.getTeamValue(homeTM.slug, homeTM.id)
            homeValue = info.value
            if (info.value)
              result.adjustmentFactors.push(
                `${match.homeTeam} value: ${(info.value / 1e6).toFixed(0)}M €`
              )
          } catch (_) {}
          try {
            homeInjuries = await transfermarktService.getTeamInjuries(homeTM.slug, homeTM.id)
            if (homeInjuries.length > 0)
              result.adjustmentFactors.push(`${match.homeTeam} injuries: ${homeInjuries.length}`)
          } catch (_) {}
        }
        if (awayTM) {
          try {
            const info = await transfermarktService.getTeamValue(awayTM.slug, awayTM.id)
            awayValue = info.value
          } catch (_) {}
          try {
            awayInjuries = await transfermarktService.getTeamInjuries(awayTM.slug, awayTM.id)
            if (awayInjuries.length > 0)
              result.adjustmentFactors.push(`${match.awayTeam} injuries: ${awayInjuries.length}`)
          } catch (_) {}
        }
      }

      // 3. Adjust xG for injuries
      let adjHomeXG = this.adjustForInjuries(homeXG, homeInjuries)
      let adjAwayXG = this.adjustForInjuries(awayXG, awayInjuries)

      // 4. Adjust xG for value gap
      const adjusted = this.adjustForValueGap(adjHomeXG, adjAwayXG, homeValue, awayValue)
      adjHomeXG = adjusted.homeXG
      adjAwayXG = adjusted.awayXG

      // 5. Calculate fair probabilities via Poisson
      const probs = this.expectedScore(adjHomeXG, adjAwayXG)
      result.fairOdds = {
        home: this.probToOdds(probs.home),
        draw: this.probToOdds(probs.draw),
        away: this.probToOdds(probs.away),
      }

      // 6. Get market odds
      try {
        const dataFusion = require('./dataFusionService')
        const odds = await dataFusion.fetchOdds(match)
        if (odds && odds.home) {
          result.marketOdds = odds
        }
      } catch (_) {}

      // 7. Calculate value percentage for each outcome
      if (result.fairOdds.home > 0 && result.marketOdds) {
        const valueBets = []
        for (const outcome of ['home', 'draw', 'away']) {
          const marketOdds = result.marketOdds[outcome]
          const fairOdds = result.fairOdds[outcome]
          if (marketOdds && fairOdds && marketOdds > fairOdds) {
            const value = (marketOdds / fairOdds - 1) * 100
            valueBets.push({
              outcome,
              marketOdds,
              fairOdds,
              valuePct: parseFloat(value.toFixed(1)),
            })
          }
        }
        valueBets.sort((a, b) => b.valuePct - a.valuePct)
        result.valueBets = valueBets

        if (valueBets.length > 0) {
          result.valuePct = valueBets[0].valuePct
          result.bestValue = valueBets[0]
        }
      }

      // 8. Confidence
      const dataPoints = [result.homeXG, result.awayXG, homeValue, awayValue].filter(Boolean).length
      result.confidence = dataPoints >= 4 ? 'high' : dataPoints >= 2 ? 'medium' : 'low'

      this._setCache(cacheKey, result)
      return result
    } catch (e) {
      logger.error(
        `[VALUE-BET] Enrich failed for ${match.homeTeam} vs ${match.awayTeam}: ${e.message}`
      )
      return result
    }
  }
}

module.exports = new ValueBetEnricher()
