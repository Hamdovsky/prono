/**
 * FairOddsEstimator.js — Calcule des cotes "justes" depuis les données du modèle.
 *
 * P1-2026-08-29
 *
 * Quand AUCUN bookmaker n'a de cote pour un match, on peut calculer
 * des "fair odds" depuis :
 *   1. Les probabilités du modèle (home_win_probability, draw_probability, away_win_probability)
 *   2. Le xG des équipes (si disponible via sofascoreXgService)
 *   3. Les classements Elo (si disponible via clubelo)
 *
 * Méthode : Distribution de Poisson pour les marchés over/under.
 * Les cotes justes sont calculées comme 1/P(market),
 * avec un ajustement pour le "overround" (marge du bookmaker).
 *
 * ATTENTION : ces cotes ne sont PAS des cotes bookmaker.
 * Elles sont utilisées uniquement quand AUCUNE source bookmaker n'est disponible,
 * pour permettre au modèle de produire un pronostic même sans cotes réelles.
 * Le flag bookmaker=false est toujours appliqué.
 */

const logger = require('../core/logger')

function poissonProb(lambda, k) {
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k)
}

function factorial(n) {
  if (n <= 1) return 1
  let r = 1
  for (let i = 2; i <= n; i++) r *= i
  return r
}

function poissonLambda(avgGoals) {
  return Math.max(avgGoals, 0.1)
}

function estimateFair1X2(modelProbs) {
  const { home = 33, draw = 33, away = 33 } = modelProbs
  const total = home + draw + away
  if (total === 0) return null
  const fairHome = home / total
  const fairDraw = draw / total
  const fairAway = away / total
  const eps = 0.001
  if (fairHome < eps || fairDraw < eps || fairAway < eps) return null
  return {
    home: +((1 / fairHome) * 1.05).toFixed(2),
    draw: +((1 / fairDraw) * 1.05).toFixed(2),
    away: +((1 / fairAway) * 1.05).toFixed(2),
  }
}

function estimateFairOverUnder(xgHome, xgAway) {
  const lambdaH = poissonLambda(xgHome || 1.4)
  const lambdaA = poissonLambda(xgAway || 1.1)

  let probOver15 = 0, probOver25 = 0, probUnder25 = 0, probBttsYes = 0

  for (let h = 0; h <= 5; h++) {
    for (let a = 0; a <= 5; a++) {
      const p = poissonProb(lambdaH, h) * poissonProb(lambdaA, a)
      if (h + a >= 1.5) probOver15 += p
      if (h + a >= 2.5) probOver25 += p
      if (h + a < 2.5) probUnder25 += p
      if (h >= 1 && a >= 1) probBttsYes += p
    }
  }

  const MARGIN = 1.06
  const eps = 0.01
  if (probOver25 < eps || probUnder25 < eps) return null

  return {
    over25: probOver25 > eps ? +((1 / probOver25) * MARGIN).toFixed(2) : null,
    under25: probUnder25 > eps ? +((1 / probUnder25) * MARGIN).toFixed(2) : null,
    over15: probOver15 > eps ? +((1 / probOver15) * MARGIN).toFixed(2) : null,
    under15: +(1 / (1 - probOver15)).toFixed(2),
    btts_yes: probBttsYes > eps ? +((1 / probBttsYes) * MARGIN).toFixed(2) : null,
  }
}

function estimateFairOuFromGoals(expectedGoalsH, expectedGoalsA) {
  const lambdaH = poissonLambda(expectedGoalsH || 1.4)
  const lambdaA = poissonLambda(expectedGoalsA || 1.1)

  const OU_LINES = [0.5, 1.5, 2.5, 3.5, 4.5]
  const result = {}
  const MARGIN = 1.06

  for (const line of OU_LINES) {
    let probUnder = 0
    for (let total = 0; total < line; total++) {
      for (let h = 0; h <= total; h++) {
        const a = total - h
        probUnder += poissonProb(lambdaH, h) * poissonProb(lambdaA, a)
      }
    }
    const probOver = 1 - probUnder
    if (probOver > 0.01 && probUnder > 0.01) {
      result[`over${line}`] = +((1 / probOver) * MARGIN).toFixed(2)
      result[`under${line}`] = +((1 / probUnder) * MARGIN).toFixed(2)
    }
  }
  return result
}

async function fetchFairOdds(match) {
  const homeProb = parseFloat(match.home_win_probability) || 0
  const drawProb = parseFloat(match.draw_probability) || 0
  const awayProb = parseFloat(match.away_win_probability) || 0

  const xgHome = parseFloat(match.home_xg) || null
  const xgAway = parseFloat(match.away_xg) || null

  const modelProbs = {
    home: homeProb,
    draw: drawProb,
    away: awayProb,
  }

  const result = {
    source: 'fair_odds_model',
    bookmaker: false,
    confidence: 'low',
    method: null,
  }

  const hasModelProbs = homeProb > 0 || drawProb > 0 || awayProb > 0
  const hasXg = xgHome > 0 && xgAway > 0

  if (hasModelProbs) {
    const odds1X2 = estimateFair1X2(modelProbs)
    if (odds1X2) {
      Object.assign(result, odds1X2)
      result.method = 'model_probability'
      result.confidence = hasXg ? 'high' : 'medium'
    }
  }

  if (hasXg) {
    const leagueAvg = parseFloat(match.league_avg_goals) || 2.65
    const ouOdds = estimateFairOverUnder(xgHome, xgAway, leagueAvg)
    if (ouOdds) {
      Object.assign(result, ouOdds)
      result.method = result.method === 'model_probability'
        ? 'model_probability+xg_poisson'
        : 'xg_poisson'
    }
    const fullOu = estimateFairOuFromGoals(xgHome, xgAway)
    if (fullOu) {
      Object.assign(result, fullOu)
    }
  }

  if (!result.home && !result.over25) {
    return null
  }

  logger.info(`[FAIR-ODDS] ${match.homeTeam || match.home_team} vs ${match.awayTeam || match.away_team}: method=${result.method} confidence=${result.confidence} home=${result.home} over25=${result.over25}`)
  return result
}

module.exports = { fetchFairOdds, estimateFair1X2, estimateFairOverUnder, estimateFairOuFromGoals }
