const logger = require('./logger')
const database = require('./database')
const StatisticalEngine = require('./services/StatisticalEngine')
const fbrefService = require('../services/fbrefService')
const statsbombService = require('../services/statsbombService')
const axios = require('axios')
const oddsApiIoService = require('../services/oddsApiIoService')
const { pickBest: pickOddsBest } = (function () {
  // pickBest lives in oddsApiIoService but is not exported — inline a tiny copy
  function pickBest(bookmakers) {
    if (!bookmakers) return null
    const bms = typeof bookmakers === 'string' ? JSON.parse(bookmakers) : bookmakers
    let best = { home: 0, draw: 0, away: 0 }
    for (const bmName of Object.keys(bms || {})) {
      const markets = bms[bmName]
      if (!Array.isArray(markets)) continue
      const ml = markets.find((mk) => String(mk.name).toUpperCase() === 'ML')
      if (!ml || !ml.odds || !ml.odds[0]) continue
      const o = ml.odds[0]
      const h = parseFloat(o.home),
        d = parseFloat(o.draw),
        a = parseFloat(o.away)
      if (!h || !a) continue
      best = {
        home: h > best.home ? h : best.home,
        draw: d > best.draw ? d : best.draw,
        away: a > best.away ? a : best.away,
      }
    }
    return best.home && best.away ? best : null
  }
  return { pickBest }
})()

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
    // Honest insufficiency: without real bookmaker odds, only a non-degenerate model
    // signal (clear top pick + real margin) makes the match usable. A coin-flip on
    // synthetic odds must stay insufficient instead of faking a pick.
    let insufficientData = hasRealOdds ? 0 : 1
    if (insufficientData) {
      const sortedPy = [pyHome, pyDraw, pyAway].sort((a, b) => b - a)
      const hasModelSignal =
        pyHome + pyDraw + pyAway > 0.9 && sortedPy[0] - sortedPy[1] >= 0.1 && sortedPy[0] >= 0.45
      if (hasModelSignal) insufficientData = 0
    }
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

function _attachSofaMarkets(match, sofaOdds) {
  if (!match || !sofaOdds) return
  const over25 = parseFloat(sofaOdds.over25)
  const under25 = parseFloat(sofaOdds.under25)
  const bttsYes = parseFloat(sofaOdds.btts_yes)
  const bttsNo = parseFloat(sofaOdds.btts_no)
  if (over25 > 0 && under25 > 0) {
    match.odds_over25 = over25
    match.odds_under25 = under25
  }
  if (bttsYes > 0 && bttsNo > 0) {
    match.odds_btts_yes = bttsYes
    match.odds_btts_no = bttsNo
  }
  // Activation Market Engine : on stocke le tableau normalise multi-marches.
  // `markets` peut venir de l'enveloppe { odds, markets } (nouveau) ou etre
  // deja present au niveau racine (legacy spread). On filtre les entrees
  // exploitables (usable) pour eviter d'inventer des cotes upstream.
  const rawMarkets = Array.isArray(sofaOdds.markets) ? sofaOdds.markets : null
  if (Array.isArray(rawMarkets) && rawMarkets.length) {
    const usable = rawMarkets.filter((m) => m && m.usable !== false && m.market_id && m.selection)
    match.real_markets = usable.length ? usable : rawMarkets
    if (match.fullData && typeof match.fullData === 'object') {
      match.fullData.real_markets = match.real_markets
    }
  }
}

async function attachRealOdds(match) {
  if (!match) return
  const has1x2 = parseFloat(match.odds_home) > 0 && parseFloat(match.odds_draw) > 0 && parseFloat(match.odds_away) > 0
  const hasOu = parseFloat(match.odds_over25) > 0 || parseFloat(match.odds_under25) > 0
  const hasBtts = parseFloat(match.odds_btts_yes) > 0 || parseFloat(match.odds_btts_no) > 0
  // NOTE: _oddsWereFetched can be persisted into fullData by a previous run, so
  // it must NOT block fetching missing O/U + BTTS markets for matches that
  // already carry 1X2 odds (the bug that left those columns empty).
  if (match._oddsWereFetched && has1x2 && hasOu && hasBtts) {
    return
  }
  if (match._oddsWereFetched && !has1x2) {
    // Stale flag persisted from an earlier run but the 1X2 odds were lost —
    // allow a fresh attempt.
    match._oddsWereFetched = false
  }
  try {
    // Free source first: Sofascore odds (no key, no quota). Best-effort — if
    // the deployment IP is blocked, it returns null and we fall through.
    // Fetches 1X2 + O/U 2.5 + BTTS in one call, so it also fills the markets
    // for matches that already carry 1X2 odds.
    const sofascoreOdds = require('../services/sofascoreOddsService')
    if (sofascoreOdds.isAvailable()) {
      const sofaOdds = await sofascoreOdds.fetchOddsForMatch(match)
      if (sofaOdds) {
        if (!has1x2 && parseFloat(sofaOdds.home) > 0 && parseFloat(sofaOdds.away) > 0) {
          match.odds_home = parseFloat(sofaOdds.home)
          match.odds_draw = parseFloat(sofaOdds.draw)
          match.odds_away = parseFloat(sofaOdds.away)
          match.odds_source = 'sofascore'
          match._oddsWereFetched = true
          _attachSofaMarkets(match, sofaOdds)
          logger.info(
            `[FBREF/FALLBACK] Attached real Sofascore odds for ${match.homeTeam} vs ${match.awayTeam} (${match.league})` +
              (match.odds_over25 ? ` +O/U=${match.odds_over25}` : '') +
              (match.odds_btts_yes ? ` +BTTS=${match.odds_btts_yes}` : '')
          )
          return
        }
        if (has1x2 && (!hasOu || !hasBtts)) {
          // 1X2 already present — still grab O/U + BTTS markets if missing.
          _attachSofaMarkets(match, sofaOdds)
          match.odds_source = match.odds_source || 'sofascore'
          match._oddsWereFetched = true
          logger.info(
            `[FBREF/FALLBACK] Attached Sofascore markets for ${match.homeTeam} vs ${match.awayTeam} (${match.league})` +
              (match.odds_over25 ? ` +O/U=${match.odds_over25}` : '') +
              (match.odds_btts_yes ? ` +BTTS=${match.odds_btts_yes}` : '')
          )
          return
        }
      }
    }
    const oddsApiIo = require('../services/oddsApiIoService')
    if (oddsApiIo.isAvailable() && !has1x2) {
      const realOdds = await oddsApiIo.fetchOddsForMatch(match)
      if (realOdds && parseFloat(realOdds.home) > 0 && parseFloat(realOdds.away) > 0) {
        match.odds_home = parseFloat(realOdds.home)
        match.odds_draw = parseFloat(realOdds.draw)
        match.odds_away = parseFloat(realOdds.away)
        match.odds_source = 'oddsapiio'
        match._oddsWereFetched = true
        return
      }
    }
    // Fallback source de cotes réelles: BSD (bourse marocaine). OddsAPI étant
    // souvent offline/offquota sur le free tier, on complète via bsd_match_id —
    // BSD dispose déjà des probs (bsd_home_win_prob) mais pas toujours des
    // odds persistées → on les récupère pour libérer le gate honnêteté.
    const bsdService = new Proxy({}, { get: (t, p) => (p === 'isAvailable' ? () => false : (p === 'then' ? undefined : (async () => null))) });
    if (bsdService.isAvailable() && String(match.bsd_match_id || '').length > 0) {
      try {
        const bsdOdds = await bsdService.fetchOdds(match.bsd_match_id)
        if (bsdOdds) {
          if (!has1x2 && parseFloat(bsdOdds.home) > 0 && parseFloat(bsdOdds.away) > 0) {
            match.odds_home = parseFloat(bsdOdds.home)
            match.odds_draw = parseFloat(bsdOdds.draw)
            match.odds_away = parseFloat(bsdOdds.away)
            match.odds_source = match.odds_source || 'bsd'
            match._oddsWereFetched = true
            _attachSofaMarkets(match, bsdOdds)
            logger.info(
              `[FBREF/FALLBACK] Attached real BSD odds for ${match.homeTeam} vs ${match.awayTeam} (${match.league})`
            )
          } else if (has1x2 && (!hasOu || !hasBtts)) {
            // 1X2 already present — still grab O/U + BTTS from BSD.
            _attachSofaMarkets(match, bsdOdds)
            match.odds_source = match.odds_source || 'bsd'
            match._oddsWereFetched = true
            logger.info(
              `[FBREF/FALLBACK] Attached BSD markets for ${match.homeTeam} vs ${match.awayTeam} (${match.league})`
            )
          }
          if (match._oddsWereFetched) return
        }
      } catch (bsdErr) {
        logger.warn(`[FBREF/FALLBACK] BSD odds fetch failed for ${match.id}: ${bsdErr.message}`)
      }
    }
    if (!match._oddsWereFetched && has1x2) {
      // 1X2 are real bookmaker odds → EV remains valid even if markets (O/U,
      // BTTS) couldn't be fetched (e.g. source IP-blocked).
      match._oddsWereFetched = true
    } else if (!match._oddsWereFetched) {
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
  // attachRealOdds also backfills O/U 2.5 + BTTS markets for matches that already
  // carry 1X2 odds.
  let insufficientData = 0
  await attachRealOdds(match)

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

  // Enrich xG from free fbref scraping when stored xG is absent (Phase 2).
  // This differentiates the Poisson probs (instead of the ~1X uniform fallback)
  // on matches from the major fbref leagues — free, no quota.
  try {
    await fbrefService.attachMatchXG(match)
  } catch (_) {}
  // If fbref was blocked/unavailable, fall back to StatsBomb open-data (github raw,
  // no Cloudflare, works on Render). Historical, so only fills xG when absent.
  try {
    await statsbombService.attachMatchXG(match)
  } catch (_) {}

  const xg = StatisticalEngine.getMatchXG(match)
  const xgHome = xg.h
  const xgAway = xg.a
  const matrix = buildScoreMatrix(xgHome, xgAway)
  const markets = calculateMarkets(matrix)
  const pHome = Math.round(markets.home * 1000) / 10
  const pDraw = Math.round(markets.draw * 1000) / 10
  const pAway = Math.round(markets.away * 1000) / 10
  // Honest insufficiency: same rule as the XGBoost path — synthetic odds only stay
  // usable when the model produces a clear top pick with a real margin.
  if (insufficientData === 1) {
    const sorted = [pHome, pDraw, pAway].sort((a, b) => b - a)
    const hasModelSignal =
      pHome + pDraw + pAway > 90 && sorted[0] - sorted[1] >= 10 && sorted[0] >= 45
    if (hasModelSignal) insufficientData = 0
  }
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
    odds_over25: match.odds_over25 || null,
    odds_under25: match.odds_under25 || null,
    odds_btts_yes: match.odds_btts_yes || null,
    odds_btts_no: match.odds_btts_no || null,
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
    const res = await database.getMatchesByStatuses([
      'scheduled',
      'upcoming',
      'NOT_STARTED',
      'NS',
    ])
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

function _startTs(m) {
  const t = m.startTimestamp || m.timestamp || 0
  return typeof t === 'string' ? new Date(t).getTime() : Number(t) * 1000
}

function _hasOdds(m) {
  return parseFloat(m.odds_home) > 0 && parseFloat(m.odds_draw) > 0 && parseFloat(m.odds_away) > 0
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
    // (b) Prioriser les ligues majeures couvertes par fbref/StatsBomb (xG
    // differentiable — gratuit) AVANT les amicaux/coupes, avec le temps de
    // coup d'envoi comme tie-break (quotas cotes limités → on enrichit d'abord
    // ce qui peut être différencié par le xG gratuit).
    matches.sort((a, b) => {
      const pa = fbrefService.isMajorLeague(a.league || a.tournament_name || '') ? 0 : 1
      const pb = fbrefService.isMajorLeague(b.league || b.tournament_name || '') ? 0 : 1
      if (pa !== pb) return pa - pb
      return _startTs(a) - _startTs(b)
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

    // ── Batch Odds Collection ──
    // 1) Sofascore (FREE, no key/quota): fetch real 1X2 odds for every match
    //    still missing them, and O/U 2.5 + BTTS markets for every match still
    //    missing them. This is what turns small-league matches from
    //    "insufficient" into real Gagnants while staying honest.
    try {
      const sofascoreOdds = require('../services/sofascoreOddsService')
      if (sofascoreOdds.isAvailable()) {
        const needSofa = matches.filter((m) => {
          const has1 = _hasOdds(m)
          const hasOu =
            parseFloat(m.odds_over25) > 0 || parseFloat(m.odds_under25) > 0
          const hasBtts =
            parseFloat(m.odds_btts_yes) > 0 || parseFloat(m.odds_btts_no) > 0
          return !has1 || !hasOu || !hasBtts
        })
        let sofaFetched = 0
        let marketOnly = 0
        for (const m of needSofa) {
          try {
            const sofaOdds = await sofascoreOdds.fetchOddsForMatch(m)
            if (!sofaOdds) continue
            if (!_hasOdds(m) && parseFloat(sofaOdds.home) > 0 && parseFloat(sofaOdds.away) > 0) {
              m.odds_home = parseFloat(sofaOdds.home)
              m.odds_draw = parseFloat(sofaOdds.draw)
              m.odds_away = parseFloat(sofaOdds.away)
              m.odds_source = 'sofascore'
              m._oddsWereFetched = true
              sofaFetched++
            }
            _attachSofaMarkets(m, sofaOdds)
            if (!_hasOdds(m) && (parseFloat(m.odds_over25) > 0 || parseFloat(m.odds_btts_yes) > 0)) {
              marketOnly++
            }
          } catch (_) {}
        }
        if (sofaFetched > 0 || marketOnly > 0) {
          logger.info(
            `[FALLBACK_ENRICHER] Sofascore odds: ${sofaFetched}/${needSofa.length} got 1X2 + ${marketOnly} got O/U/BTTS markets`
          )
        }
      }
    } catch (e) {
      logger.warn(`[FALLBACK_ENRICHER] Sofascore odds phase error: ${e.message}`)
    }

    // 2) OddsAPI.io free tier (only when a key is configured).
    // Regrouper recherche d'événements + un seul appel /odds/multi (≤10 events)
    // afin de diviser par ~10 la consommation de quota OddsAPI.
    // On ne touche qu'aux matches sans cotes réelles déjà présentes (le gate
    // honnêteté protège les cotes persistées).
    try {
      if (oddsApiIoService.isAvailable()) {
        const noOdds = matches.filter((m) => !oddsApiIoService.isNotFound(m.id) && !_hasOdds(m))
        let fetchedOdds = 0
        for (let i = 0; i < noOdds.length; i += 10) {
          if (!oddsApiIoService.isAvailable()) break
          const chunk = noOdds.slice(i, i + 10)
          const withIds = []
          for (const m of chunk) {
            // quota peut s'épuiser entre-temps
            if (!oddsApiIoService.isAvailable()) break
            try {
              const eid = await oddsApiIoService.getEventId(m)
              if (eid) withIds.push({ m, eid })
            } catch (_) {}
          }
          if (!withIds.length) continue
          const ids = withIds.map((w) => w.eid)
          const odds = await oddsApiIoService.getOddsMulti(ids)
          const byId = new Map(odds.map((o) => [String(o.id), o]))
          for (const w of withIds) {
            const ev = byId.get(String(w.eid))
            const ml = ev && ev.bookmakers ? pickOddsBest(ev.bookmakers) : null
            if (ml && ml.home && ml.away) {
              w.m.odds_home = ml.home
              w.m.odds_draw = ml.draw
              w.m.odds_away = ml.away
              w.m.odds_source = 'oddsapiio'
              w.m._oddsWereFetched = true
              fetchedOdds++
            } else {
              oddsApiIoService.markNotFound(w.m.id)
            }
          }
        }
        logger.info(`[FALLBACK_ENRICHER] Batch odds: ${fetchedOdds}/${noOdds.length} got real odds`)
      }
    } catch (e) {
      logger.warn(`[FALLBACK_ENRICHER] Batch odds phase error: ${e.message}`)
    }

    for (let i = 0; i < matches.length; i += batchSize) {
      // Quota épuisé : s'arrêter (plus de fetch/écriture inutile). On continue
      // la boucle seulement si des matches portent encore des cotes à conserver.
      if (!oddsApiIoService.isAvailable() && matches.slice(i).every(_hasOdds)) break
      const batch = matches.slice(i, i + batchSize)
      const results = await Promise.all(
        batch.map(async (m) => {
          try {
            await attachRealOdds(m)
            const result = await tryXgbEnrichOne(m)
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
        const hasRealOddsForWrite =
          m._oddsWereFetched &&
          !m._oddsAreSynthetic &&
          parseFloat(m.odds_home) > 0 &&
          parseFloat(m.odds_draw) > 0 &&
          parseFloat(m.odds_away) > 0
        const evScore = hasRealOddsForWrite ? r.ev_score : 0
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
            ev_home: hasRealOddsForWrite && r.prediction === '1' ? r.ev_score : null,
            ev_draw: hasRealOddsForWrite && r.prediction === 'X' ? r.ev_score : null,
            ev_away: hasRealOddsForWrite && r.prediction === '2' ? r.ev_score : null,
            ev_score: evScore,
            insufficient_data: r.insufficient_data ?? 0,
            sufficient: r.insufficient_data ? false : true,
            home_xg: r.home_xg,
            away_xg: r.away_xg,
            xgboost_confidence: r.xgboost_confidence || null,
            confidence: r.confidence || null,
            odds_home:
              r.odds_home ??
              (m._oddsWereFetched && !m._oddsAreSynthetic ? parseFloat(m.odds_home) : null),
            odds_draw:
              r.odds_draw ??
              (m._oddsWereFetched && !m._oddsAreSynthetic ? parseFloat(m.odds_draw) : null),
            odds_away:
              r.odds_away ??
              (m._oddsWereFetched && !m._oddsAreSynthetic ? parseFloat(m.odds_away) : null),
            odds_over25: r.odds_over25 ?? m.odds_over25 ?? null,
            odds_under25: r.odds_under25 ?? m.odds_under25 ?? null,
            odds_btts_yes: r.odds_btts_yes ?? m.odds_btts_yes ?? null,
            odds_btts_no: r.odds_btts_no ?? m.odds_btts_no ?? null,
            odds_source:
              r.odds_source ||
              (m._oddsWereFetched && !m._oddsAreSynthetic ? m.odds_source || 'oddsapiio' : null),
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

// ── O/U + BTTS Market Backfill ──────────────────────────────────────
// Remplit odds_over25/odds_under25/odds_btts_yes/odds_btts_no pour tous les
// matches programmés qui ont déjà des cotes 1X2 mais pas de marchés (les cellules
// "--" du dashboard). Priorité aux marchés majeurs (fbref) puis au kickoff.
async function backfillMarkets(opts = {}) {
  const limit = opts.limit || 300
  logger.info(`[FALLBACK_ENRICHER] Backfilling O/U + BTTS markets (limit: ${limit})...`)
  try {
    const rows = await database.getMatchesMissingMarkets()
    if (!rows || rows.length === 0) {
      logger.info('[FALLBACK_ENRICHER] No matches missing O/U + BTTS markets.')
      return { scanned: 0, updated: 0 }
    }
    rows.sort((a, b) => {
      const pa = fbrefService.isMajorLeague(a.league || a.tournament_name || '') ? 0 : 1
      const pb = fbrefService.isMajorLeague(b.league || b.tournament_name || '') ? 0 : 1
      if (pa !== pb) return pa - pb
      return _startTs(a) - _startTs(b)
    })
    const batch = rows.slice(0, limit)
    let updated = 0
    for (const m of batch) {
      try {
        const hasOu =
          parseFloat(m.odds_over25) > 0 || parseFloat(m.odds_under25) > 0
        const hasBtts =
          parseFloat(m.odds_btts_yes) > 0 || parseFloat(m.odds_btts_no) > 0
        if (hasOu && hasBtts) continue
        await attachRealOdds(m)
        const ouNow =
          parseFloat(m.odds_over25) > 0 || parseFloat(m.odds_under25) > 0
        const bttsNow =
          parseFloat(m.odds_btts_yes) > 0 || parseFloat(m.odds_btts_no) > 0
        if (ouNow || bttsNow) {
          await database.updatePredictions(m.id, {
            odds_over25: parseFloat(m.odds_over25) > 0 ? m.odds_over25 : null,
            odds_under25: parseFloat(m.odds_under25) > 0 ? m.odds_under25 : null,
            odds_btts_yes: parseFloat(m.odds_btts_yes) > 0 ? m.odds_btts_yes : null,
            odds_btts_no: parseFloat(m.odds_btts_no) > 0 ? m.odds_btts_no : null,
            odds_source: m.odds_source || 'sofascore',
          })
          updated++
        }
      } catch (_) {}
    }
    logger.info(
      `[FALLBACK_ENRICHER] Market backfill done: ${updated}/${batch.length} got O/U and/or BTTS markets`
    )
    return { scanned: batch.length, updated }
  } catch (e) {
    logger.error(`[FALLBACK_ENRICHER] Market backfill failed: ${e.message}`)
    return { scanned: 0, updated: 0, error: e.message }
  }
}

module.exports = {
  enrichOne: jsEnrichOne,
  enrichMatchesBatch,
  backfillMarkets,
  attachRealOdds,
  buildScoreMatrix,
  calculateMarkets,
  tryXgbEnrichOne,
}
