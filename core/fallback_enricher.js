const logger = require('./logger')
const database = require('./database')
const StatisticalEngine = require('./services/StatisticalEngine')
const axios = require('axios')

const FASTAPI_URL = process.env.INFERENCE_URL || 'http://127.0.0.1:8000'
const XGB_TIMEOUT = parseInt(process.env.XGB_INFERENCE_TIMEOUT || '60000')

function factorial(n) {
  if (n < 2) return 1
  let r = 1
  for (let i = 2; i <= n; i++) r *= i
  return r
}

function poissonProb(x, lambda) {
  if (lambda <= 0) return x === 0 ? 1 : 0
  return (Math.exp(-lambda) * Math.pow(lambda, x)) / factorial(x)
}

function buildScoreMatrix(xgHome, xgAway, maxGoals = 8) {
  const matrix = []
  for (let h = 0; h <= maxGoals; h++) {
    matrix[h] = []
    const ph = poissonProb(h, xgHome)
    for (let a = 0; a <= maxGoals; a++) {
      const pa = poissonProb(a, xgAway)
      matrix[h][a] = ph * pa
    }
  }
  return matrix
}

function calculateMarkets(matrix) {
  const maxGoals = matrix.length - 1
  let home = 0,
    draw = 0,
    away = 0
  let over25 = 0,
    bttsYes = 0
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = matrix[h][a]
      if (h > a) home += p
      else if (h === a) draw += p
      else away += p
      if (h + a > 2.5) over25 += p
      if (h > 0 && a > 0) bttsYes += p
    }
  }
  const total = home + draw + away
  if (total > 0) {
    home /= total
    draw /= total
    away /= total
  }
  return { home, draw, away, over_25: over25, btts_yes: bttsYes }
}

function determinePick(pHome, pDraw, pAway) {
  const picks = [
    { label: '1', prob: pHome },
    { label: 'X', prob: pDraw },
    { label: '2', prob: pAway },
  ]
  picks.sort((a, b) => b.prob - a.prob)
  const best = picks[0]
  const ev = Math.round(((best.prob / 100) * 2.0 - 1.0) * 100) / 100
  return { pick: best.label, prob: Math.round(best.prob * 10) / 10, ev }
}

function buildPredictionObject(
  match,
  pHome,
  pDraw,
  pAway,
  xgHome,
  xgAway,
  source,
  insufficientData = 0,
  confidence = null
) {
  const ou25 = Math.round((pHome / 100) * (pDraw / 100) * 100 > 0 ? 50 : 50)
  const matrix = buildScoreMatrix(xgHome, xgAway)
  const markets = calculateMarkets(matrix)
  const cleanOu25 = Math.round(markets.over_25 * 1000) / 10
  const cleanBtts = Math.round(markets.btts_yes * 1000) / 10
  const { pick, prob, ev } = determinePick(pHome, pDraw, pAway)
  return {
    home_win_probability: pHome,
    draw_probability: pDraw,
    away_win_probability: pAway,
    ou_25_prob: cleanOu25,
    btts_prob: cleanBtts,
    expected_score: `${Math.round(xgHome)} - ${Math.round(xgAway)}`,
    prediction: pick,
    prediction_probability: prob,
    ev_score: ev,
    insufficient_data: insufficientData,
    source: source,
    home_xg: Math.round(xgHome * 100) / 100,
    away_xg: Math.round(xgAway * 100) / 100,
  }
}

async function tryXgbEnrichOne(match) {
  try {
    const teamStats =
      typeof match.teamStats === 'string'
        ? JSON.parse(match.teamStats || '{}')
        : match.teamStats || {}
    const formCtx =
      typeof match.form_context === 'string'
        ? JSON.parse(match.form_context || '{}')
        : match.form_context || {}
    const h2h =
      typeof match.h2h_data === 'string' ? JSON.parse(match.h2h_data || '{}') : match.h2h_data || {}

    const hasRealOdds =
      parseFloat(match.odds_home) > 0 &&
      parseFloat(match.odds_draw) > 0 &&
      parseFloat(match.odds_away) > 0
    const insufficientData = hasRealOdds ? 0 : 1

    const payload = {
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      league: match.league || match.tournament_name || '',
      odds_home: parseFloat(match.odds_home) || 2.0,
      odds_draw: parseFloat(match.odds_draw) || 3.0,
      odds_away: parseFloat(match.odds_away) || 3.0,
      startTimestamp: match.startTimestamp || match.timestamp || 0,
      task: 'PREDICTION',
      teamStats: teamStats,
      form_context: formCtx,
      h2h_data: h2h,
      weather_temp: parseFloat(match.weather_temp) || null,
      weather_humidity: parseFloat(match.weather_humidity) || null,
      weather_desc: match.weather_desc || null,
      player_ratings: parseFloat(match.player_ratings) || null,
      home_xg: parseFloat(match.home_xg) || null,
      away_xg: parseFloat(match.away_xg) || null,
      home_form_pts: parseFloat(match.home_form_pts) || null,
      away_form_pts: parseFloat(match.away_form_pts) || null,
    }
    const response = await axios.post(`${FASTAPI_URL}/predict`, payload, {
      timeout: XGB_TIMEOUT,
      headers: { 'Content-Type': 'application/json' },
    })
    const py = response.data
    if (!py || !py.success) return null
    const pyHome = parseFloat(py.home_win_probability) || 0
    const pyDraw = parseFloat(py.draw_probability) || 0
    const pyAway = parseFloat(py.away_win_probability) || 0
    if (pyHome + pyDraw + pyAway <= 0.01) return null
    const xgbConf = parseFloat(py.xgboost_confidence || py.confidence || 0)
    const pHome = +(pyHome * 100).toFixed(1)
    const pDraw = +(pyDraw * 100).toFixed(1)
    const pAway = +(pyAway * 100).toFixed(1)
    // Mix logic: reject XGBoost if confidence < 40% or draw > 50% (cold match suspicion)
    if (xgbConf < 0.4 || pDraw > 50) return null
    const xgH = parseFloat(py.home_xg) || parseFloat(py.expected_goals_home) || 1.5
    const xgA = parseFloat(py.away_xg) || parseFloat(py.expected_goals_away) || 1.15
    const result = buildPredictionObject(
      match,
      pHome,
      pDraw,
      pAway,
      xgH,
      xgA,
      'xgb_fastapi_v553',
      insufficientData
    )
    result.xgboost_confidence = xgbConf
    result.confidence = xgbConf * 100
    result.ou_25_prob = py.ou_25_prob ? Math.round(py.ou_25_prob * 100) : result.ou_25_prob
    result.btts_prob = py.btts_prob ? Math.round(py.btts_prob * 100) : result.btts_prob
    return { id: match.id || match.match_id || '', success: true, ...result }
  } catch (e) {
    return null
  }
}

async function attachRealOdds(match) {
  if (!match || match._oddsWereFetched) return
  if (match.odds_home && match.odds_draw && match.odds_away) {
    match._oddsWereFetched = true
    return
  }
  try {
    const oddsApiIo = require('../services/oddsApiIoService')
    if (!oddsApiIo.isAvailable()) return
    const realOdds = await oddsApiIo.fetchOddsForMatch(match)
    if (realOdds && parseFloat(realOdds.home) > 0 && parseFloat(realOdds.away) > 0) {
      match.odds_home = parseFloat(realOdds.home)
      match.odds_draw = parseFloat(realOdds.draw)
      match.odds_away = parseFloat(realOdds.away)
      match.odds_source = 'oddsapiio'
      match._oddsWereFetched = true
    } else {
      match._oddsWereFetched = false
    }
  } catch (_) {}
}

async function jsEnrichOne(match) {
  const matchId = match.id || match.match_id || ''
  const home = match.homeTeam || ''
  const away = match.awayTeam || ''
  if (!home || !away) {
    return { id: matchId, success: false, error: 'Missing homeTeam/awayTeam' }
  }

  // If no real odds present, try to fetch REAL bookmaker odds (OddsAPI.io 1xbet/22Bet)
  // before falling back to synthetic odds. This is what turns small-league matches
  // from "insufficient" into real Gagnants while staying honest (real odds only).
  let insufficientData = 0
  if (!match.odds_home || !match.odds_draw || !match.odds_away) {
    await attachRealOdds(match)
  } else {
    match._oddsWereFetched = true
  }

  if (match._oddsWereFetched) {
    const hasAll = parseFloat(match.odds_home) > 0 && parseFloat(match.odds_away) > 0
    if (!hasAll) {
      const synth = _generateSyntheticOdds(home, away, match.league)
      match.odds_home = synth.home
      match.odds_draw = synth.draw
      match.odds_away = synth.away
      match._oddsAreSynthetic = true
      insufficientData = 1
    }
  } else {
    const synth = _generateSyntheticOdds(home, away, match.league)
    match.odds_home = synth.home
    match.odds_draw = synth.draw
    match.odds_away = synth.away
    match._oddsAreSynthetic = true
    insufficientData = 1
  }

  const xg = StatisticalEngine.getMatchXG(match)
  const xgHome = xg.h
  const xgAway = xg.a
  const matrix = buildScoreMatrix(xgHome, xgAway)
  const markets = calculateMarkets(matrix)
  const pHome = Math.round(markets.home * 1000) / 10
  const pDraw = Math.round(markets.draw * 1000) / 10
  const pAway = Math.round(markets.away * 1000) / 10
  const result = buildPredictionObject(
    match,
    pHome,
    pDraw,
    pAway,
    xgHome,
    xgAway,
    'fallback_js',
    insufficientData
  )
  return {
    id: matchId,
    success: true,
    ...result,
    odds_home: match._oddsWereFetched && !match._oddsAreSynthetic ? match.odds_home : null,
    odds_draw: match._oddsWereFetched && !match._oddsAreSynthetic ? match.odds_draw : null,
    odds_away: match._oddsWereFetched && !match._oddsAreSynthetic ? match.odds_away : null,
    odds_source: match.odds_source || null,
  }
}

/**
 * Generate deterministic synthetic odds from team names when no bookmaker odds exist.
 * Creates unique but consistent per-match differentiation.
 */
function _generateSyntheticOdds(homeTeam, awayTeam, league) {
  const str = `${homeTeam || 'Home'}_vs_${awayTeam || 'Away'}_${league || ''}`
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    hash = (hash << 5) - hash + ch
    hash = hash & hash
  }
  const seed = Math.abs(hash) / 2147483647
  const seed2 = ((hash >> 8) & 0xff) / 255
  const leagueLower = (league || '').toLowerCase()
  let baseRange = 0.5
  if (/champions|premier|liga|bundesliga|serie a|ligue 1|eredivisie/i.test(leagueLower))
    baseRange = 0.6
  else if (/championship|serie b|ligue 2|mls|allsvenskan/i.test(leagueLower)) baseRange = 0.45
  else baseRange = 0.35
  const homeProb = 0.15 + seed * baseRange
  const drawProb = 0.12 + seed2 * 0.2
  const awayProb = Math.max(0.08, 1 - homeProb - drawProb)
  const margin = 1.05
  return {
    home: parseFloat((margin / homeProb).toFixed(2)),
    draw: parseFloat((margin / drawProb).toFixed(2)),
    away: parseFloat((margin / awayProb).toFixed(2)),
  }
}

async function getStaleMatches() {
  try {
    const res = await database.getAllMatches()
    if (!res || res.length === 0) return []
    const stale = res.filter((m) => {
      const h = parseFloat(m.home_win_probability)
      const d = parseFloat(m.draw_probability)
      const a = parseFloat(m.away_win_probability)
      const allZero = (!h && !d && !a) || (h === 0 && d === 0 && a === 0)
      const isScheduled = ['scheduled', 'upcoming', 'NOT_STARTED', 'NS'].includes(m.status)
      return allZero && isScheduled && m.homeTeam && m.awayTeam
    })
    logger.info(`[FALLBACK_ENRICHER] Found ${stale.length} stale (zero-prob) matches.`)
    return stale.slice(0, 300)
  } catch (e) {
    logger.error(`[FALLBACK_ENRICHER] getStaleMatches error: ${e.message}`)
    return []
  }
}

async function enrichMatchesBatch(opts = {}) {
  const limit = opts.limit || 999
  logger.info(`[FALLBACK_ENRICHER] Starting batch enrichment (limit: ${limit})...`)
  try {
    const [insufficient, stale] = await Promise.all([
      database.getInsufficientDataMatches(),
      getStaleMatches(),
    ])
    const seen = new Set()
    let matches = [...(insufficient || []), ...(stale || [])].filter((m) => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })
    if (matches.length > limit) {
      matches = matches.slice(0, limit)
      logger.info(`[FALLBACK_ENRICHER] Capped to ${limit} matches for memory safety`)
    }
    if (!matches || matches.length === 0) {
      logger.info('[FALLBACK_ENRICHER] No matches found for enrichment.')
      return { enriched: 0, total: 0 }
    }
    logger.info(
      `[FALLBACK_ENRICHER] Found ${matches.length} matches. Trying XGBoost (FastAPI) first...`
    )
    let enriched = 0
    let xgbOk = 0
    let jsOk = 0
    let failed = 0
    const batchSize = 5

    // Pre-fetch SofaScore team data for matches with team IDs
    const enrichedPredictionService = require('../core/enriched_predictions')
    let sofaFetchCount = 0
    for (const m of matches) {
      if (m._sofaTeamDataFetched) continue
      const hasIds =
        m.home_team_id ||
        m._homeTeamId ||
        (typeof m.id === 'string' && m.id.startsWith('livescore_'))
      if (!hasIds) continue
      try {
        await enrichedPredictionService._fetchSofaTeamData(m)
        if (m._sofaTeamDataFetched) sofaFetchCount++
      } catch (_) {}
    }
    if (sofaFetchCount > 0) {
      logger.info(
        `[FALLBACK_ENRICHER] Pre-fetched SofaScore team data for ${sofaFetchCount} matches`
      )
    }

    for (let i = 0; i < matches.length; i += batchSize) {
      const batch = matches.slice(i, i + batchSize)
      const results = await Promise.all(
        batch.map(async (m) => {
          try {
            await attachRealOdds(m)
            let result = await tryXgbEnrichOne(m)
            if (result && result.success) {
              xgbOk++
              return { match: m, result }
            }
          } catch (_) {}
          try {
            const result = await jsEnrichOne(m)
            if (result && result.success) {
              jsOk++
              return { match: m, result }
            }
          } catch (_) {}
          failed++
          return null
        })
      )
      for (const item of results) {
        if (!item) continue
        const m = item.match
        const r = item.result
try {
            await database.updatePredictions(m.id, {
              home_win_probability: r.home_win_probability,
              draw_probability: r.draw_probability,
              away_win_probability: r.away_win_probability,
              ou_25_prob: r.ou_25_prob,
              btts_prob: r.btts_prob,
              expected_score: r.expected_score,
              prediction: r.prediction,
              prediction_probability: r.prediction_probability,
              ev_home: r.prediction === '1' ? r.ev_score : null,
              ev_draw: r.prediction === 'X' ? r.ev_score : null,
              ev_away: r.prediction === '2' ? r.ev_score : null,
              ev_score: r.ev_score,
              insufficient_data: r.insufficient_data ?? 0,
              home_xg: r.home_xg,
              away_xg: r.away_xg,
              xgboost_confidence: r.xgboost_confidence || null,
              confidence: r.confidence || null,
              odds_home: r.odds_home ?? (m._oddsWereFetched && !m._oddsAreSynthetic ? parseFloat(m.odds_home) : null),
              odds_draw: r.odds_draw ?? (m._oddsWereFetched && !m._oddsAreSynthetic ? parseFloat(m.odds_draw) : null),
              odds_away: r.odds_away ?? (m._oddsWereFetched && !m._oddsAreSynthetic ? parseFloat(m.odds_away) : null),
              odds_source: r.odds_source || (m._oddsWereFetched && !m._oddsAreSynthetic ? m.odds_source || 'oddsapiio' : null),
            })
            enriched++
          } catch (e) {
          logger.error(`[FALLBACK_ENRICHER] DB write error ${m.id}: ${e.message}`)
        }
      }
      if (i + batchSize < matches.length) {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    logger.info(
      `[FALLBACK_ENRICHER] Done: ${enriched}/${matches.length} (XGBoost:${xgbOk} JS:${jsOk} Failed:${failed})`
    )
    return { enriched, total: matches.length, xgbOk, jsOk, failed }
  } catch (e) {
    logger.error(`[FALLBACK_ENRICHER] Batch failed: ${e.message}`)
    return { enriched: 0, total: 0, error: e.message }
  }
}

module.exports = {
  enrichOne: jsEnrichOne,
  enrichMatchesBatch,
  buildScoreMatrix,
  calculateMarkets,
  tryXgbEnrichOne,
}
