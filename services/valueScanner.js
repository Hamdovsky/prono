const logger = require('../core/logger')
const scrapedOddsService = require('./scrapedOddsService')

function calculateEV(ourProb, marketOdds) {
  if (marketOdds <= 1 || ourProb <= 0) return { ev: 0, kelly: 0 }
  const marketImplied = 1 / marketOdds
  const ev = (ourProb * marketOdds) - 1
  const kelly = ev > 0 ? (ourProb * (marketOdds - 1) - (1 - ourProb)) / (marketOdds - 1) : 0
  const kellyFrac = Math.max(0, kelly * 0.25)
  return {
    ev: round(ev, 4),
    evPct: round(ev * 100, 2),
    kelly: round(kellyFrac, 4),
    edge: round((ourProb / marketImplied) - 1, 4),
    marketImplied: round(marketImplied, 4),
  }
}

async function getBestOdds(match) {
  try {
    const scraped = await scrapedOddsService.getLatestOdds(
      match.homeTeam || match.home_team,
      match.awayTeam || match.away_team,
      match.league || match.league_name
    )
    if (scraped && scraped.odds_home > 1) {
      return {
        odds_home: parseFloat(scraped.odds_home),
        odds_draw: parseFloat(scraped.odds_draw) || 0,
        odds_away: parseFloat(scraped.odds_away),
        source: 'scraped',
        scraped_at: scraped.scraped_at
      }
    }
  } catch (e) {}
  return {
    odds_home: parseFloat(match.odds_home || match.odds_h || 0),
    odds_draw: parseFloat(match.odds_draw || 0),
    odds_away: parseFloat(match.odds_away || match.odds_a || 0),
    source: 'match',
  }
}

async function scanMatch(match, prediction) {
  const pH = prediction.home_win_probability || 0.33
  const pD = prediction.draw_probability || 0.34
  const pA = prediction.away_win_probability || 0.33

  const odds = await getBestOdds(match)
  const results = []
  if (odds.odds_home > 1) {
    const ev = calculateEV(pH, odds.odds_home)
    if (ev.ev > 0.02) results.push({ selection: match.homeTeam, type: 'Home', ourProb: pH, odds: odds.odds_home, oddsSource: odds.source, ...ev })
  }
  if (odds.odds_draw > 1) {
    const ev = calculateEV(pD, odds.odds_draw)
    if (ev.ev > 0.02) results.push({ selection: 'Draw', type: 'Draw', ourProb: pD, odds: odds.odds_draw, oddsSource: odds.source, ...ev })
  }
  if (odds.odds_away > 1) {
    const ev = calculateEV(pA, odds.odds_away)
    if (ev.ev > 0.02) results.push({ selection: match.awayTeam, type: 'Away', ourProb: pA, odds: odds.odds_away, oddsSource: odds.source, ...ev })
  }
  return results
}

async function scanOverUnder(match, prediction, line = 2.5) {
  const ouProb = line === 2.5 ? (prediction.ou_25_prob || 0.5) : 0.5
  const odds = await scrapedOddsService.getLatestOdds(
    match.homeTeam || match.home_team,
    match.awayTeam || match.away_team,
    match.league || match.league_name
  )
  const marketOU = odds?.odds_over_25 || parseFloat(match.odds_over || match[`odds_over_${line}`] || 0)
  if (marketOU > 1) {
    const ev = calculateEV(ouProb, marketOU)
    if (ev.ev > 0.02) {
      return { selection: `Over ${line}`, ourProb: ouProb, odds: marketOU, oddsSource: odds?.source || 'match', ...ev }
    }
  }
  return null
}

async function scanAll(matches, predictions) {
  const opportunities = []
  for (const m of matches) {
    const pred = predictions[m.id]
    if (!pred || !pred.success) continue
    const bets = await scanMatch(m, pred)
    opportunities.push(...bets.map(b => ({ matchId: m.id, home: m.homeTeam, away: m.awayTeam, league: m.league, ...b })))
    const ou = await scanOverUnder(m, pred, 2.5)
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
