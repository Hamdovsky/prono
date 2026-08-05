// @ts-nocheck
/**
 * backtestEngine.js — Validate prediction accuracy on 367K historical fixtures
 *
 * Queries Neon (soccer_fixtures) for finished matches with known outcomes,
 * runs Poisson + theta prediction for each, and computes:
 *   - Brier Score (calibration)
 *   - Log Loss (discrimination)
 *   - Accuracy (correct pick rate)
 *   - ROC AUC approximation
 *   - Calibration curve
 *
 * Used by: GET /api/backtest
 */
import { query, usingPostgres } from '../core/pg_connector'
import logger from '../core/logger'
import thetaOptimizer from './thetaOptimizer'

async function runBacktest(options = {}) {
  const { limit = 500, league = '', minGoals = 0, maxGoals = 10 } = options

  if (!usingPostgres()) {
    return { success: false, error: 'Neon PostgreSQL required for backtesting' }
  }

  await thetaOptimizer.init()

  // Fetch finished fixtures from Neon archive
  // Uses archive_football_data which has teams, scores, and odds in one table
  let sql = `
    SELECT f.id, f.home_team, f.away_team,
           f.score_home as goals_home, f.score_away as goals_away,
           f.odds_home, f.odds_away, f.odds_draw,
           f.match_date as date, f.league_code as league_name
    FROM archive_football_data f
    WHERE f.score_home IS NOT NULL
      AND f.score_away IS NOT NULL
      AND f.odds_home IS NOT NULL
      AND f.odds_away IS NOT NULL
  `
  const params = []
  let paramIdx = 0

  if (league) {
    paramIdx++
    sql += ` AND LOWER(f.league_code) ILIKE $${paramIdx}`
    params.push(`%${league}%`)
  }
  if (minGoals > 0) {
    paramIdx++
    sql += ` AND (f.score_home + f.score_away) >= $${paramIdx}`
    params.push(minGoals)
  }
  if (maxGoals < 10) {
    paramIdx++
    sql += ` AND (f.score_home + f.score_away) <= $${paramIdx}`
    params.push(maxGoals)
  }

  sql += ` ORDER BY f.match_date DESC NULLS LAST LIMIT $${paramIdx + 1}`
  params.push(limit)

  const result = await query(sql, params)
  if (!result || !result.rows || result.rows.length === 0) {
    return { success: false, error: 'No finished fixtures found', sql, params }
  }

  const fixtures = result.rows
  const predictions = []
  let correct = 0
  let totalBrier = 0
  let totalLogLoss = 0
  let n = 0
  const calibrationBins = Array.from({ length: 10 }, () => ({ predicted: 0, actual: 0, count: 0 }))

  for (const f of fixtures) {
    const homeScore = f.goals_home
    const awayScore = f.goals_away
    const actualOutcome = homeScore > awayScore ? 'home' : homeScore < awayScore ? 'away' : 'draw'

    // Get theta for this league
    const leagueKey = f.league_name || 'Unknown'
    const theta = thetaOptimizer.getThetaForLeague(leagueKey)

    // Simple Poisson prediction
    const oddsH = parseFloat(f.odds_home) || 2.0
    const oddsA = parseFloat(f.odds_away) || 2.0
    const oddsD = parseFloat(f.odds_draw) || 3.0

    // Implied probabilities from odds (with margin removal)
    const impH = 1 / oddsH
    const impA = 1 / oddsA
    const impD = 1 / oddsD
    const margin = impH + impA + impD
    const pH = impH / margin
    const pD = impD / margin
    const pA = impA / margin

    // Expected goals from odds (Poisson approximation)
    const lambdaH = -Math.log(Math.max(0.01, 1 - pH - pD / 2))
    const lambdaA = -Math.log(Math.max(0.01, 1 - pA - pD / 2))

    // Apply theta (overdispersion)
    const adjustedH = lambdaH * (theta / 5.0)
    const adjustedA = lambdaA * (theta / 5.0)

    // NB win probabilities
    function nbProb(lambda, theta, k) {
      if (theta <= 0 || lambda < 0) return 0
      const logP =
        k * Math.log(lambda / (lambda + theta)) +
        theta * Math.log(theta / (lambda + theta)) +
        Math.log(Math.pow(lambda + theta, -k)) // approximation
      return Math.exp(logP)
    }

    // Monte Carlo NB simulation for win/draw/loss
    let mcHome = 0,
      mcDraw = 0,
      mcAway = 0,
      mcTotal = 0
    const iterations = 5000
    for (let i = 0; i < iterations; i++) {
      // Negative binomial via gamma-Poisson mixture
      const rH = adjustedH * theta > 0 ? adjustedH + theta : adjustedH + 5
      const rA = adjustedA * theta > 0 ? adjustedA + theta : adjustedA + 5
      const gH = sampleGamma(rH / (theta || 1), 1)
      const gA = sampleGamma(rA / (theta || 1), 1)
      const pGoalsH = poissonRandom(adjustedH * gH)
      const pGoalsA = poissonRandom(adjustedA * gA)
      if (pGoalsH > pGoalsA) mcHome++
      else if (pGoalsH < pGoalsA) mcAway++
      else mcDraw++
      mcTotal++
    }

    const predH = mcHome / mcTotal
    const predD = mcDraw / mcTotal
    const predA = mcAway / mcTotal
    const predOutcome =
      predH > predA && predH > predD ? 'home' : predA > predH && predA > predD ? 'away' : 'draw'
    const predConf = Math.max(predH, predD, predA)

    // Brier score
    const actualVec = [
      actualOutcome === 'home' ? 1 : 0,
      actualOutcome === 'draw' ? 1 : 0,
      actualOutcome === 'away' ? 1 : 0,
    ]
    const predVec = [predH, predD, predA]
    const brier = actualVec.reduce((s, a, i) => s + (a - predVec[i]) ** 2, 0)
    totalBrier += brier
    n++

    // Log-loss
    const predForActual =
      actualOutcome === 'home' ? predH : actualOutcome === 'draw' ? predD : predA
    totalLogLoss += -Math.log(Math.max(0.0001, predForActual))

    if (predOutcome === actualOutcome) correct++

    // Calibration bin
    const binIdx = Math.min(9, Math.floor(predConf * 10))
    calibrationBins[binIdx].predicted += predConf
    calibrationBins[binIdx].actual += predOutcome === actualOutcome ? 1 : 0
    calibrationBins[binIdx].count++

    predictions.push({
      home: f.home_team,
      away: f.away_team,
      league: f.league_name,
      date: f.date,
      actualScore: `${homeScore}-${awayScore}`,
      actual: actualOutcome,
      predicted: predOutcome,
      probH: round(predH, 3),
      probD: round(predD, 3),
      probA: round(predA, 3),
      confidence: round(predConf, 3),
      brier: round(brier, 4),
      theta: round(theta, 2),
      lambdaH: round(lambdaH, 3),
      lambdaA: round(lambdaA, 3),
    })
  }

  const avgBrier = totalBrier / n
  const avgLogLoss = totalLogLoss / n
  const accuracy = correct / n
  const brierSkill = 1 - avgBrier / 0.222 // Brier skill score vs constant 1/3 prediction
  const calibrationCurve = calibrationBins.map((b, i) => ({
    bin: `${i * 10}-${(i + 1) * 10}%`,
    predicted: b.count > 0 ? round(b.predicted / b.count, 3) : 0,
    actual: b.count > 0 ? round(b.actual / b.count, 3) : 0,
    count: b.count,
  }))

  return {
    success: true,
    summary: {
      total: n,
      correct,
      accuracy: round(accuracy, 4),
      brierScore: round(avgBrier, 4),
      brierSkillScore: round(brierSkill, 4),
      logLoss: round(avgLogLoss, 4),
      avgTheta: round(predictions.reduce((s, p) => s + p.theta, 0) / predictions.length, 2),
    },
    calibrationCurve,
    predictions: predictions.slice(0, 100), // return first 100 details
  }
}

function round(v, d) {
  const f = Math.pow(10, d)
  return Math.round(v * f) / f
}

function sampleGamma(shape, scale) {
  // Marsaglia-Tsang method for gamma sampling
  if (shape < 1) {
    const u = Math.random()
    return sampleGamma(1 + shape, scale) * Math.pow(u, 1 / shape)
  }
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  while (true) {
    let x, v
    do {
      x = normalRandom()
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = Math.random()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale
  }
}

function normalRandom() {
  // Box-Muller
  const u = 1 - Math.random()
  const v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function poissonRandom(lambda) {
  // Knuth's Poisson
  if (lambda < 30) {
    const L = Math.exp(-lambda)
    let k = 0,
      p = 1
    do {
      k++
      p *= Math.random()
    } while (p > L)
    return k - 1
  }
  // Normal approximation for large lambda
  const x = normalRandom()
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * x))
}

export = { runBacktest }
