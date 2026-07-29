const QuantService = require('./quantService')
const logger = require('../core/logger')

class UnifiedEngine {
  static computeVerdict(match) {
    try {
      if (!match || !match.homeTeam || !match.awayTeam) return null
      const verdict = {
        home: match.homeTeam,
        away: match.awayTeam,
        league: match.league || match.tournament_name || 'Unknown',
        time: match.timestamp || match.startTimestamp || null,
      }

      // 1. Collect ALL probability sources
      const sources = []

      // Source A: ML model probabilities
      const mlHome = parseFloat(match.home_win_probability || 0)
      const mlDraw = parseFloat(match.draw_probability || 0)
      const mlAway = parseFloat(match.away_win_probability || 0)
      if (mlHome > 0 || mlAway > 0) {
        sources.push({
          name: 'ML',
          h: mlHome / 100,
          x: mlDraw / 100,
          a: mlAway / 100,
        })
      }

      // Source B: Market odds (Shin de-vig)
      if (match.odds_home && match.odds_draw && match.odds_away) {
        const market = QuantService.removeMarginShin([
          match.odds_home,
          match.odds_draw,
          match.odds_away,
        ])
        sources.push({
          name: 'MARCHE',
          h: market[0],
          x: market[1],
          a: market[2],
        })
      }

      // Source C: BSD (bookmaker) probabilities - raw percentage values (0-100)
      const bsdH = parseFloat(match.bsd_home_win_prob || 0)
      const bsdD = parseFloat(match.bsd_draw_prob || 0)
      const bsdA = parseFloat(match.bsd_away_win_prob || 0)
      if (bsdH > 0 || bsdA > 0) {
        const t = bsdH + bsdD + bsdA || 1
        sources.push({
          name: 'BSD',
          h: bsdH / t,
          x: bsdD / t,
          a: bsdA / t,
        })
      }

      // Source D: xG-based Poisson probabilities
      if (match.home_xg != null && match.away_xg != null) {
        const xgH = parseFloat(match.home_xg)
        const xgA = parseFloat(match.away_xg)
        const { win: poisson } = this.poissonProbs(xgH, xgA)
        sources.push({
          name: 'xG',
          h: poisson.home,
          x: poisson.draw,
          a: poisson.away,
        })
      }

      verdict.sources = sources

      // 2. Compute consensus
      if (sources.length === 0) {
        verdict.status = 'NO_DATA'
        verdict.pick = null
        verdict.confidence = 0
        return verdict
      }

      const avg = sources.reduce(
        (acc, s) => ({ h: acc.h + s.h, x: acc.x + s.x, a: acc.a + s.a }),
        { h: 0, x: 0, a: 0 }
      )
      const n = sources.length
      const consensus = { h: avg.h / n, x: avg.x / n, a: avg.a / n }
      verdict.consensus = consensus

      // 3. Pick = highest consensus probability
      const outcomes = [
        { label: '1', prob: consensus.h },
        { label: 'X', prob: consensus.x },
        { label: '2', prob: consensus.a },
      ].sort((a, b) => b.prob - a.prob)

      const pick = outcomes[0]
      const second = outcomes[1]
      verdict.pick = pick.label
      verdict.pickProb = Math.round(pick.prob * 100)
      verdict.edge = +(pick.prob - second.prob).toFixed(3)

      // 4. Confidence: higher edge + more sources = more confident
      const baseConf = Math.min(99, Math.round(pick.prob * 100))
      const edgeBonus = Math.round(verdict.edge * 50)
      const sourceBonus = Math.min(15, (n - 1) * 5)
      verdict.confidence = Math.min(99, baseConf + edgeBonus + sourceBonus)

      // 5. Value detection
      verdict.value = null
      if (match.odds_home && match.odds_draw && match.odds_away) {
        const odds = { 1: match.odds_home, X: match.odds_draw, 2: match.odds_away }
        const marketProb = 1 / odds[pick.label]
        const modelProb = pick.prob
        const ev = modelProb * odds[pick.label] - 1
        const valuePct = ((odds[pick.label] / (1 / modelProb)) - 1) * 100
        verdict.value = {
          odds: odds[pick.label],
          fairOdds: +(1 / modelProb).toFixed(2),
          ev: +(ev * 100).toFixed(1),
          valuePct: +valuePct.toFixed(1),
        }
        // Kelly stake
        if (ev > 0) {
          verdict.kelly = +(QuantService.calculateKellyFraction(modelProb, odds[pick.label], 0.25) * 100).toFixed(1)
        } else {
          verdict.kelly = 0
        }
      }

      // 6. Trap detection: sources disagree
      const picks = sources.map((s) => {
        const sorted = [
          { v: '1', p: s.h },
          { v: 'X', p: s.x },
          { v: '2', p: s.a },
        ].sort((a, b) => b.p - a.p)
        return sorted[0].v
      })
      const uniquePicks = [...new Set(picks)]
      verdict.trap = uniquePicks.length > 1
      verdict.sourcesAgree = uniquePicks.length
      verdict.trapDetail =
        uniquePicks.length > 1
          ? `Desaccord: ${picks.join(' vs ')} (sources: ${sources.map((s) => s.name).join(', ')})`
          : null

      // 7. Classification
      if (verdict.trap) {
        verdict.tier = 'PIEGE'
      } else if (verdict.value && verdict.value.ev > 5) {
        verdict.tier = '🔥 VALUE'
      } else if (verdict.confidence >= 75) {
        verdict.tier = '💎 SOLIDE'
      } else if (verdict.confidence >= 60) {
        verdict.tier = '📊 MOYEN'
      } else {
        verdict.tier = '⚠️ RISQUE'
      }

      verdict.status = 'READY'
      return verdict
    } catch (e) {
      logger.warn(`[UNIFIED] computeVerdict error for ${match.homeTeam}: ${e.message}`)
      return null
    }
  }

  static poissonProbs(lambdaH, lambdaA) {
    const poisson = (k, lam) => Math.exp(-lam) * Math.pow(lam, k) / factorial(k)
    const factorial = (n) => (n <= 1 ? 1 : n * factorial(n - 1))
    let home = 0, draw = 0, away = 0
    for (let h = 0; h <= 10; h++) {
      for (let a = 0; a <= 10; a++) {
        const prob = poisson(h, lambdaH) * poisson(a, lambdaA)
        if (h > a) home += prob
        else if (h === a) draw += prob
        else away += prob
      }
    }
    return { win: { home, draw, away } }
  }

  static buildDailySheet(matches) {
    const verdicts = matches.map((m) => this.computeVerdict(m)).filter(Boolean)

    const byTier = {}
    for (const v of verdicts) {
      const tier = v.tier || 'AUTRE'
      if (!byTier[tier]) byTier[tier] = []
      byTier[tier].push(v)
    }

    const valueBets = verdicts.filter((v) => v.value && v.value.ev > 2)
    const traps = verdicts.filter((v) => v.trap)
    const solids = verdicts.filter((v) => v.tier === '💎 SOLIDE')

    return {
      generatedAt: new Date().toISOString(),
      total: verdicts.length,
      verdicts,
      summary: {
        totalValueBets: valueBets.length,
        totalTraps: traps.length,
        totalSolids: solids.length,
        byTier: Object.fromEntries(
          Object.entries(byTier).map(([k, v]) => [k, v.length])
        ),
      },
      highlights: {
        valueBets: valueBets.sort((a, b) => (b.value?.ev || 0) - (a.value?.ev || 0)).slice(0, 10),
        traps: traps.slice(0, 10),
        solids: solids.slice(0, 10),
      },
    }
  }
}

module.exports = UnifiedEngine
