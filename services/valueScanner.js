/**
 * valueScanner.js — Positive EV Detection Engine
 *
 * Compares our predicted probabilities vs market-implied probabilities
 * to find value bets where we disagree with the market in a profitable way.
 *
 * Kelly stake sizing with fractional safety (0.25 Kelly).
 */
const logger = require('../core/logger')

function calculateEV(ourProb, marketOdds) {
  if (marketOdds <= 1 || ourProb <= 0) return { ev: 0, kelly: 0 }
  const marketImplied = 1 / marketOdds
  const ev = (ourProb * marketOdds) - 1
  const kelly = ev > 0 ? (ourProb * (marketOdds - 1) - (1 - ourProb)) / (marketOdds - 1) : 0
  const kellyFrac = Math.max(0, kelly * 0.25) // quarter Kelly for safety
  return {
    ev: round(ev, 4),
    evPct: round(ev * 100, 2),
    kelly: round(kellyFrac, 4),
    edge: round((ourProb / marketImplied) - 1, 4),
    marketImplied: round(marketImplied, 4),
  }
}

function scanMatch(match, prediction) {
  const pH = prediction.home_win_probability || 0.33
  const pD = prediction.draw_probability || 0.34
  const pA = prediction.away_win_probability || 0.33

  const oddsH = parseFloat(match.odds_home || match.odds_h || 0)
  const oddsD = parseFloat(match.odds_draw || 0)
  const oddsA = parseFloat(match.odds_away || match.odds_a || 0)

  const results = []
  if (oddsH > 1) {
    const ev = calculateEV(pH, oddsH)
    if (ev.ev > 0.02) results.push({ selection: match.homeTeam, type: 'Home', ourProb: pH, odds: oddsH, ...ev })
  }
  if (oddsD > 1) {
    const ev = calculateEV(pD, oddsD)
    if (ev.ev > 0.02) results.push({ selection: 'Draw', type: 'Draw', ourProb: pD, odds: oddsD, ...ev })
  }
  if (oddsA > 1) {
    const ev = calculateEV(pA, oddsA)
    if (ev.ev > 0.02) results.push({ selection: match.awayTeam, type: 'Away', ourProb: pA, odds: oddsA, ...ev })
  }
  return results
}

function scanOverUnder(match, prediction, line = 2.5) {
  const ouProb = line === 2.5 ? (prediction.ou_25_prob || 0.5) : 0.5
  const marketOU = parseFloat(match.odds_over || match[`odds_over_${line}`] || 0)
  if (marketOU > 1) {
    const ev = calculateEV(ouProb, marketOU)
    if (ev.ev > 0.02) {
      return { selection: `Over ${line}`, ourProb: ouProb, odds: marketOU, ...ev }
    }
  }
  return null
}

function scanAll(matches, predictions) {
  const opportunities = []
  for (const m of matches) {
    const pred = predictions[m.id]
    if (!pred || !pred.success) continue
    const bets = scanMatch(m, pred)
    opportunities.push(...bets.map(b => ({ matchId: m.id, home: m.homeTeam, away: m.awayTeam, league: m.league, ...b })))
    const ou = scanOverUnder(m, pred, 2.5)
    if (ou) opportunities.push({ matchId: m.id, home: m.homeTeam, away: m.awayTeam, league: m.league, ...ou })
  }
  opportunities.sort((a, b) => b.ev - a.ev)
  return opportunities
}

function round(v, d) {
  const f = Math.pow(10, d)
  return Math.round(v * f) / f
}

module.exports = { calculateEV, scanMatch, scanOverUnder, scanAll }
