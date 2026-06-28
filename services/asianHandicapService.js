/**
 * asianHandicapService.js — Asian Handicap Analysis
 * Converts 1X2 odds → AH lines, detects value vs model, tracks movement.
 */
const logger = require('../core/logger')

const LINE_THRESHOLDS = [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5]

/**
 * Convert decimal odds to implied probability
 */
function impliedProb(odds) {
  if (!odds || odds <= 1) return 0
  return 1 / odds
}

/**
 * Convert 1X2 probabilities to Asian handicap fair line
 * Uses the Home - Away probability differential
 */
function probToAHLine(probH, probA) {
  const diff = probH - probA
  if (diff > 0.35) return { line: -1.5, favourite: 'home', confidence: 'HIGH' }
  if (diff > 0.25) return { line: -1.0, favourite: 'home', confidence: 'HIGH' }
  if (diff > 0.15) return { line: -0.75, favourite: 'home', confidence: 'MED' }
  if (diff > 0.08) return { line: -0.5, favourite: 'home', confidence: 'MED' }
  if (diff > 0.03) return { line: -0.25, favourite: 'home', confidence: 'LOW' }
  if (diff < -0.35) return { line: 1.5, favourite: 'away', confidence: 'HIGH' }
  if (diff < -0.25) return { line: 1.0, favourite: 'away', confidence: 'HIGH' }
  if (diff < -0.15) return { line: 0.75, favourite: 'away', confidence: 'MED' }
  if (diff < -0.08) return { line: 0.5, favourite: 'away', confidence: 'MED' }
  if (diff < -0.03) return { line: 0.25, favourite: 'away', confidence: 'LOW' }
  return { line: 0, favourite: 'draw', confidence: 'LOW' }
}

/**
 * Estimate AH odds for a given line using the Poisson model
 */
function estimateAHOdds(line, xgH, xgA) {
  const lambdaH = Math.max(xgH, 0.1)
  const lambdaA = Math.max(xgA, 0.1)
  const sims = 50000
  let homeCover = 0
  let awayCover = 0

  for (let i = 0; i < sims; i++) {
    const gH = poissonRandom(lambdaH)
    const gA = poissonRandom(lambdaA)
    const net = gH - gA
    const adjusted = net - line
    if (adjusted > 0) homeCover++
    else if (adjusted < 0) awayCover++
  }

  const homeProb = homeCover / sims
  const awayProb = awayCover / sims
  const pushProb = 1 - homeProb - awayProb

  return {
    homeAHodds: homeProb > 0 ? +(1 / homeProb).toFixed(2) : null,
    awayAHodds: awayProb > 0 ? +(1 / awayProb).toFixed(2) : null,
    homeProb: +homeProb.toFixed(4),
    awayProb: +awayProb.toFixed(4),
    pushProb: +pushProb.toFixed(4),
    edge: homeProb - awayProb,
  }
}

function poissonRandom(lambda) {
  const L = Math.exp(-lambda)
  let k = 0
  let p = 1
  do {
    k++
    p *= Math.random()
  } while (p > L)
  return k - 1
}

/**
 * Detect steam on AH line by comparing opening vs current 1X2 odds
 */
function detectAHSteam(oddsHomeOpen, oddsAwayOpen, oddsHomeCurr, oddsAwayCurr) {
  if (!oddsHomeOpen || !oddsAwayOpen || !oddsHomeCurr || !oddsAwayCurr) {
    return { steamDetected: false }
  }

  const openHome = impliedProb(oddsHomeOpen)
  const openAway = impliedProb(oddsAwayOpen)
  const currHome = impliedProb(oddsHomeCurr)
  const currAway = impliedProb(oddsAwayCurr)

  const homeShift = currHome - openHome
  const awayShift = currAway - openAway

  if (homeShift > 0.05 && awayShift < -0.03) {
    return { steamDetected: true, direction: 'home', shift: +homeShift.toFixed(3) }
  }
  if (awayShift > 0.05 && homeShift < -0.03) {
    return { steamDetected: true, direction: 'away', shift: +awayShift.toFixed(3) }
  }
  return { steamDetected: false }
}

/**
 * Full AH analysis for a match
 */
function analyzeMatch(match, modelProbs) {
  try {
    const oddsH = parseFloat(match.odds_home) || 0
    const oddsD = parseFloat(match.odds_draw) || 0
    const oddsA = parseFloat(match.odds_away) || 0
    const oddsHOpen = parseFloat(match.odds_home_open) || 0
    const oddsAOpen = parseFloat(match.odds_away_open) || 0

    const modelH = modelProbs?.h ?? modelProbs?.home ?? 0.33
    const modelA = modelProbs?.a ?? modelProbs?.away ?? 0.33
    const xgH = modelProbs?.xgH ?? modelProbs?.homeXG ?? 1.2
    const xgA = modelProbs?.xgA ?? modelProbs?.awayXG ?? 1.0

    const marketAH = probToAHLine(impliedProb(oddsH), impliedProb(oddsA))
    const modelAH = probToAHLine(modelH, modelA)
    const ahOdds = estimateAHOdds(modelAH.line, xgH, xgA)
    const steam = detectAHSteam(oddsHOpen, oddsAOpen, oddsH, oddsA)

    const lineDiff = Math.abs(marketAH.line - modelAH.line)
    const isValue = lineDiff >= 0.25 && modelAH.confidence !== 'LOW'

    return {
      marketLine: marketAH.line,
      marketFavourite: marketAH.favourite,
      modelLine: modelAH.line,
      modelFavourite: modelAH.favourite,
      modelConfidence: modelAH.confidence,
      homeAHodds: ahOdds.homeAHodds,
      awayAHodds: ahOdds.awayAHodds,
      homeAHEdge: ahOdds.edge,
      lineDisagreement: lineDiff,
      isValue,
      steam: steam.steamDetected ? { direction: steam.direction, shift: steam.shift } : null,
    }
  } catch (e) {
    logger.error(`[AH] analyzeMatch error: ${e.message}`)
    return null
  }
}

module.exports = { analyzeMatch, probToAHLine, estimateAHOdds, detectAHSteam }
