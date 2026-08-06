const http = require('http')
const logger = require('./logger')
const MatchAuditor = require('../services/MatchAuditor')

/**
 * Enriched Predictions Service
 * Génère des prédictions complètes (gagnant, corners, cartons, buts) pour chaque match
 */

const { spawn } = require('child_process')
const path = require('path')
const newsService = require('../src/services/newsService')
const axiosModule = require('axios')
const dataFusionService = require('../services/dataFusionService')
const { detectBookmakerTrap } = require('../services/oddsMovementService')
const { analyzeValue } = require('../src/services/ValueBetEngine')
const DeepFormService = require('../services/DeepFormService')
const PlayerPropsService = require('../services/playerPropsService')
const pythonService = require('./pythonService')

const goalNewsService = require('../services/goalNewsService')
const sharpService = require('../services/SharpIntelligenceService')
const correlationEngine = require('../services/MarketCorrelationEngine')
const fpisEngine = require('../services/FPISEngine')
const motivationService = require('../services/MotivationEnrichService')
const EnvironmentalIntelligence = require('../services/EnvironmentalIntelligence')
const bankrollService = require('../services/bankrollService') // V90
const NewsAnalysisService = require('./services/NewsAnalysisService')
const MarketIntelligenceService = require('./services/MarketIntelligenceService')
const StatisticalEngine = require('./services/StatisticalEngine')
const adaptiveLearningEngine = require('../services/adaptiveLearningEngine')
const patternService = require('../services/patternService')
const SmartOddsAnalyzer = require('../services/SmartOddsAnalyzer')
const DiagnosticTrace = require('./utils/DiagnosticTrace')
const Schemas = require('./utils/Schemas')
const QuantumQuantEngine = require('./QuantumQuantEngine')
const confidenceScorer = require('./confidenceScorer')
const featureEngineer = require('./services/FeatureEngineer')

const SOFA_API = 'https://www.sofascore.com/api/v1'
const SOFA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://www.sofascore.com',
  Referer: 'https://www.sofascore.com/',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
}

const NEG_KWS = [
  'injured',
  ' out ',
  'out for',
  'red card',
  'suspended',
  'ruled out',
  'doubtful',
  'sidelined',
  'absent',
  'unavailable',
  'misses',
  'missing',
]
const POS_KWS = [
  'returned',
  ' available ',
  'fit again',
  'back in training',
  'recovered',
  'back from injury',
  'returns to squad',
  'cleared to play',
]
const ROLE_WEIGHTS = {
  GK: -15, // Increased impact for keeper
  ST: -12, // Critical scorer
  DF: -8,
  MD: -6,
  ROT: -15, // Huge impact for second team/rotation
  MGR: 8,
}

const ROLE_KWS = {
  GK: ['keeper', 'goalkeeper', 'gk', 'goal keeper', 'حارس'],
  ST: ['striker', 'forward', 'goalscorer', 'top-scorer', 'leading scorer', 'هداف'],
  DF: ['defender', 'captain', 'center-back', 'centre-back', 'full-back', 'مدافع'],
  MD: ['midfield', 'midfielder', 'playmaker', 'cam ', ' dm ', 'وسط'],
  ROT: [
    'second team',
    'reserve team',
    'rotated',
    'resting players',
    'bench players',
    'تشكيلة ثانية',
    'احتياط',
    'إراحة',
  ],
  MGR: ['manager', 'head coach', 'gaffer', 'appointed as', 'مدرب'],
}

class EnrichedPredictionService {
  constructor() {
    this.pythonService = pythonService
  }

  calculateNewsScore(headlines, confirmedInjuries = [], teamAvgRating = null) {
    return NewsAnalysisService.calculateNewsScore(headlines, confirmedInjuries, teamAvgRating)
  }

  /**
   * Fetch SofaScore team stats (form, H2H, season stats) to populate
   * match.teamStats, match.form_context, match.h2h_data before ML prediction.
   * Requires home_team_id / away_team_id on the match object.
   */
  /**
   * Search SofaScore by team name to get SofaScore team ID.
   * Used when LiveScore IDs don't match SofaScore IDs.
   */
  async _searchSofaTeamByName(teamName) {
    if (!teamName) return null
    try {
      const url = `${SOFA_API}/search/teams?q=${encodeURIComponent(teamName)}`
      const resp = await axiosModule.get(url, { headers: SOFA_HEADERS, timeout: 6000 })
      const results = resp.data?.results || []
      if (results.length === 0) return null
      // Prefer exact name match, then first result
      const exact = results.find((r) => r.name?.toLowerCase() === teamName.toLowerCase())
      const best = exact || results[0]
      return best?.id || null
    } catch (_) {
      return null
    }
  }

  async _fetchSofaTeamData(match) {
    // Try to extract team IDs from fullData JSON if columns are missing
    if (!match.home_team_id && !match._homeTeamId) {
      try {
        const fd =
          typeof match.fullData === 'string' ? JSON.parse(match.fullData) : match.fullData || {}
        if (fd.homeTeamId) match._homeTeamId = fd.homeTeamId
        if (fd.awayTeamId) match._awayTeamId = fd.awayTeamId
        if (fd.sofaMatchId) match._sofaMatchId = fd.sofaMatchId
      } catch (_) {}
    }
    let homeId = match.home_team_id || match._homeTeamId
    let awayId = match.away_team_id || match._awayTeamId
    const sofaId =
      match.sofascore_id ||
      match._sofaMatchId ||
      (typeof match.id === 'string' && match.id.startsWith('sofascore_')
        ? match.id.replace('sofascore_', '')
        : null)

    // Strip ".0" suffix from LiveScore IDs (e.g., "100419.0" → "100419")
    if (homeId && typeof homeId === 'string' && homeId.endsWith('.0'))
      homeId = homeId.replace('.0', '')
    if (awayId && typeof awayId === 'string' && awayId.endsWith('.0'))
      awayId = awayId.replace('.0', '')

    if (!homeId || !awayId) {
      // No IDs at all — try name search as last resort
      if (match.homeTeam && match.awayTeam) {
        const [hSofaId, aSofaId] = await Promise.all([
          this._searchSofaTeamByName(match.homeTeam),
          this._searchSofaTeamByName(match.awayTeam),
        ])
        if (hSofaId) homeId = String(hSofaId)
        if (aSofaId) awayId = String(aSofaId)
        if (!homeId || !awayId) return
      } else {
        return
      }
    }

    try {
      const headers = {
        ...SOFA_HEADERS,
        Referer: `https://www.sofascore.com/team/football/team/${homeId}`,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      }

      const fetchJson = async (url) => {
        const resp = await axiosModule.get(url, { headers, timeout: 8000 })
        return resp.data
      }

      // 1. Fetch match details to get tournament/season IDs
      let tournamentId = match.tournament_id || null
      let seasonId = match._seasonId || null
      if (sofaId && (!tournamentId || !seasonId)) {
        try {
          const details = await fetchJson(`${SOFA_API}/event/${sofaId}`)
          const ev = details.event || details
          tournamentId = tournamentId || ev.tournament?.uniqueTournament?.id
          seasonId = seasonId || ev.season?.id
        } catch (_) {}
      }

      // 1.5 If IDs didn't yield tournament/season, try name search for proper SofaScore IDs
      if (!tournamentId || !seasonId) {
        if (match.homeTeam && match.awayTeam) {
          const [hSofaId, aSofaId] = await Promise.all([
            this._searchSofaTeamByName(match.homeTeam),
            this._searchSofaTeamByName(match.awayTeam),
          ])
          if (hSofaId) homeId = String(hSofaId)
          if (aSofaId) awayId = String(aSofaId)
          // Try fetching tournament/season from team's recent events
          if (hSofaId) {
            try {
              const teamEvents = await fetchJson(`${SOFA_API}/team/${hSofaId}/events/last/0`)
              const lastEvent = (teamEvents?.events || [])[0]
              if (lastEvent?.tournament?.uniqueTournament?.id) {
                tournamentId = lastEvent.tournament.uniqueTournament.id
                seasonId = lastEvent.season?.id
              }
            } catch (_) {}
          }
        }
      }

      // 2. Parallel: team form (last 5) + H2H + season stats
      const [homeFormResp, awayFormResp, h2hResp, homeSeasonStats, awaySeasonStats] =
        await Promise.all([
          tournamentId && seasonId
            ? fetchJson(
                `${SOFA_API}/team/${homeId}/unique-tournament/${tournamentId}/season/${seasonId}/events/last/5`
              ).catch(() => null)
            : Promise.resolve(null),
          tournamentId && seasonId
            ? fetchJson(
                `${SOFA_API}/team/${awayId}/unique-tournament/${tournamentId}/season/${seasonId}/events/last/5`
              ).catch(() => null)
            : Promise.resolve(null),
          sofaId
            ? fetchJson(`${SOFA_API}/event/${sofaId}/h2h/events`).catch(() => null)
            : Promise.resolve(null),
          tournamentId && seasonId
            ? this.fetchSofaTeamStats(homeId, tournamentId, seasonId).catch(() => null)
            : Promise.resolve(null),
          tournamentId && seasonId
            ? this.fetchSofaTeamStats(awayId, tournamentId, seasonId).catch(() => null)
            : Promise.resolve(null),
        ])

      // 3. Parse form averages
      const _avgForm = (resp, teamId, seasonStats) => {
        const events = resp?.events || []
        if (!events.length && !seasonStats) return null
        let gf = 0,
          ga = 0,
          wins = 0,
          draws = 0,
          losses = 0,
          xgFor = 0,
          xgAgainst = 0
        for (const ev of events) {
          const isHome = ev.homeTeam?.id === teamId
          const hs = ev.homeScore?.current ?? 0
          const as = ev.awayScore?.current ?? 0
          const hxg = ev.homeXg || ev.homeScore?.expectedGoals || 0
          const axg = ev.awayXg || ev.awayScore?.expectedGoals || 0
          gf += isHome ? hs : as
          ga += isHome ? as : hs
          xgFor += isHome ? hxg : axg
          xgAgainst += isHome ? axg : hxg
          if ((isHome && hs > as) || (!isHome && as > hs)) wins++
          else if (hs === as) draws++
          else losses++
        }
        const n = events.length
        return {
          avgGoalsScored: n > 0 ? gf / n : seasonStats?.avgGoalsScored || 1.3,
          avgGoalsConceded: n > 0 ? ga / n : seasonStats?.avgGoalsConceded || 1.1,
          avgXgFor: n > 0 ? xgFor / n : 0,
          avgXgAgainst: n > 0 ? xgAgainst / n : 0,
          avgPossession: seasonStats?.avgPossession || 50,
          avgShots: seasonStats?.avgShotsOnTarget
            ? Math.round(seasonStats.avgShotsOnTarget * 2.5)
            : 12,
          avgShotsOnTarget: seasonStats?.avgShotsOnTarget || 4,
          avgCorners: seasonStats?.avgCorners || 5,
          avgBigChances: seasonStats?.avgBigChances || 0,
          winRate: n > 0 ? wins / n : 0.33,
          drawRate: n > 0 ? draws / n : 0.26,
          lossRate: n > 0 ? losses / n : 0.41,
          points: n > 0 ? (wins * 3 + draws) / n : 1,
          matchesAnalyzed: n || seasonStats?.matchesPlayed || 0,
        }
      }

      const homeForm = _avgForm(homeFormResp, homeId, homeSeasonStats)
      const awayForm = _avgForm(awayFormResp, awayId, awaySeasonStats)

      // 4. Parse H2H
      const h2hEvents = (h2hResp?.events || []).slice(0, 5)
      const h2hData = {
        teamDuel: {
          lastMeetings: h2hEvents.map((ev) => ({
            homeTeam: ev.homeTeam?.name,
            awayTeam: ev.awayTeam?.name,
            homeScore: ev.homeScore?.current,
            awayScore: ev.awayScore?.current,
            startTimestamp: ev.startTimestamp,
          })),
        },
      }

      // 5. Populate match object for Python ML
      match.teamStats = match.teamStats || {}
      if (typeof match.teamStats === 'string') {
        try {
          match.teamStats = JSON.parse(match.teamStats)
        } catch (_) {
          match.teamStats = {}
        }
      }
      if (homeForm) match.teamStats.home = { ...match.teamStats.home, ...homeForm }
      if (awayForm) match.teamStats.away = { ...match.teamStats.away, ...awayForm }

      match.form_context = {
        home: homeForm
          ? {
              standing: {
                points: Math.round(homeForm.points * 30),
                wins: Math.round(homeForm.winRate * 5),
                draws: Math.round(homeForm.drawRate * 5),
                losses: Math.round(homeForm.lossRate * 5),
              },
            }
          : {},
        away: awayForm
          ? {
              standing: {
                points: Math.round(awayForm.points * 30),
                wins: Math.round(awayForm.winRate * 5),
                draws: Math.round(awayForm.drawRate * 5),
                losses: Math.round(awayForm.lossRate * 5),
              },
            }
          : {},
      }

      match.h2h_data = h2hData
      match.insufficient_data = 0
      match._sofaTeamDataFetched = true
    } catch (e) {
      logger.debug(
        `[SOFA-TEAM] Fetch failed for ${match.homeTeam} vs ${match.awayTeam}: ${e.message}`
      )
    }
  }

  /**
   * Génère des prédictions enrichies pour un match
   */
  async enrichMatch(match, timeoutMs = null) {
    if (!match) return null
    const trace = new DiagnosticTrace()

    try {
      // 0. Validate and Normalize
      match = Schemas.validateMatch(match)
      trace.step('Normalization')

      // 0.2 Fetch SofaScore team data (form, H2H) for ML features
      if (!match.teamStats && (match.home_team_id || match._homeTeamId)) {
        await this._fetchSofaTeamData(match)
        trace.step('SofaTeamData')
      }

      // 0.1 Weather Enrichment (if missing)
      if (!match.weather_temp || !match.weather_desc) {
        try {
          const weatherService = require('../services/weatherService')
          if (weatherService.isAvailable()) {
            const countryMap = {
              EN: 'London',
              ES: 'Madrid',
              IT: 'Rome',
              DE: 'Berlin',
              FR: 'Paris',
              PT: 'Lisbon',
              NL: 'Amsterdam',
              BE: 'Brussels',
              TR: 'Istanbul',
              GR: 'Athens',
              RU: 'Moscow',
              SA: 'Riyadh',
            }
            const iso = (match.country_iso || '').toUpperCase()
            const city = countryMap[iso] || match.category_name || ''
            if (city) {
              const w = await weatherService.fetchByCity(city)
              const info = weatherService.extractWeatherInfo(w)
              if (info) {
                match.weather_temp = info.temp
                match.weather_desc = info.description
                match.weather_humidity = info.humidity
              }
            }
          }
        } catch (_) {}
      }

      // 1. Parallel Task Execution (News, Odds, Environmental)
      trace.step('Parallel enrichment start')

      const configEngine = require('./configEngine')
      const newsEnabled = configEngine.get('DEEP_NEWS_ENABLED', true)

      const [liveOdds, newsIntel] = await Promise.all([
        dataFusionService.fetchOdds(match).catch((e) => {
          trace.error('Odds', e.message)
          return null
        }),
        newsEnabled
          ? newsService
              .getMatchIntelligence(
                match.id,
                match.homeTeam,
                match.awayTeam,
                match.startTimestamp,
                {
                  countryHint: match.category || '',
                  homeTeamId: match._homeTeamId || null,
                  awayTeamId: match._awayTeamId || null,
                }
              )
              .catch((e) => {
                trace.error('News', e.message)
                return null
              })
          : Promise.resolve(null),
      ])

      if (liveOdds) {
        match.odds_home = liveOdds.home
        match.odds_draw = liveOdds.draw
        match.odds_away = liveOdds.away
        trace.source('Odds', 'SUCCESS', { h: liveOdds.home, a: liveOdds.away })

        // 📊 [QUANT] Record Market Snapshot
        try {
          const QuantRiskService = require('../services/quantRiskService')
          QuantRiskService.recordMarketSnapshot(
            match.id,
            liveOdds,
            match.status === 'upcoming' ? 'OPENING' : 'LIVE'
          )
        } catch (e) {}
      }

      // 2. Market Intelligence and Python Prediction
      const pythonResult = await this.getAnalyticalPrediction(match, timeoutMs)
      trace.step('Python Prediction', { success: pythonResult?.success })

      // 3. News Impact Calculation
      let newsData = null
      if (newsIntel) {
        const hRating =
          match.player_ratings_home?.avgRating || match.teamStats?.home?.avgRating || null
        const aRating =
          match.player_ratings_away?.avgRating || match.teamStats?.away?.avgRating || null

        const homeImpact = NewsAnalysisService.calculateNewsScore(
          newsIntel.home.headlines,
          newsIntel.home.injuries,
          hRating
        )
        const awayImpact = NewsAnalysisService.calculateNewsScore(
          newsIntel.away.headlines,
          newsIntel.away.injuries,
          aRating
        )

        newsData = {
          ...newsIntel,
          impact: {
            home: homeImpact.score,
            away: awayImpact.score,
            home_att: homeImpact.attack,
            home_def: homeImpact.defense,
            away_att: awayImpact.attack,
            away_def: awayImpact.defense,
            chaos: homeImpact.chaos + awayImpact.chaos,
            critical: [...homeImpact.critical, ...awayImpact.critical],
          },
        }
        match.news_data = newsData
        trace.source('News', 'SUCCESS')
      }

      // 4. Market Signals
      const probs = {
        p_h: (pythonResult?.home_win_probability || 33) / 100,
        p_d: (pythonResult?.draw_probability || 33) / 100,
        p_a: (pythonResult?.away_win_probability || 33) / 100,
      }
      const marketIntel = await MarketIntelligenceService.analyze(match, probs)
      match.xgboost_confidence = MarketIntelligenceService.applyMarketBoosts(match, marketIntel)
      trace.step('Market Intelligence')

      // 4.1 Neural Pattern Analysis [V30 UPGRADE]
      const patternResults = patternService.analyze(match)
      if (patternResults.match) {
        match.neural_boost = patternResults
        if (patternResults.probability > 0.8) {
          match.isVVIP = true // Auto-promote to VVIP
        }
      }

      // 5. Final Assembly using Statistical Engine
      const winner =
        pythonResult?.home_win_probability > pythonResult?.away_win_probability
          ? match.homeTeam
          : match.awayTeam
      const winProb =
        Math.max(pythonResult?.home_win_probability || 0, pythonResult?.away_win_probability || 0) /
        100

      // 6. RLM Trap Detection
      const trapData = detectBookmakerTrap(
        match.id,
        winProb * 100,
        winner === match.homeTeam ? 'HOME' : 'AWAY',
        { home: match.odds_home, away: match.odds_away, draw: match.odds_draw }
      )

      if (trapData && trapData.isTrap) {
        trace.source('Trap Detector', 'ALERT', { severity: trapData.severity })
        match.tacticalLabels = match.tacticalLabels || []
        match.tacticalLabels.push('🛑 TRAP ALERT: ' + trapData.msg)
      }

      const enrichedMatch = {
        ...match,
        trace: trace.getSummary(),
        ai_source: pythonResult?.ai_source || match.ai_source || 'TITANIUM_ELITE_V3',
        home_win_probability: pythonResult?.home_win_probability || match.home_win_probability || 0,
        draw_probability: pythonResult?.draw_probability || match.draw_probability || 0,
        away_win_probability: pythonResult?.away_win_probability || match.away_win_probability || 0,
        expected_score: pythonResult?.expected_score || match.expected_score || null,
        xgboost_confidence:
          pythonResult?.xgboost_confidence ||
          pythonResult?.confidence ||
          match.xgboost_confidence ||
          0,
        surgical_market: pythonResult?.surgical_market || match.surgical_market || null,
        surgical_confidence: pythonResult?.surgical_confidence || match.surgical_confidence || null,
        backup_market: pythonResult?.backup_market || match.backup_market || null,
        btts_prob: pythonResult?.btts_prob || match.btts_prob || null,
        ou_25_prob: pythonResult?.ou_25_prob || match.ou_25_prob || null,
        power_score: pythonResult?.power_score || 70,
        verdict: pythonResult?.verdict || 'STRONG BET',
        enriched: {
          winner,
          winnerProbability: winProb,
          predictedCorners: StatisticalEngine.predictCorners(match, winProb),
          predictedCards: StatisticalEngine.predictCards(match),
          predictedGoals: StatisticalEngine.predictGoals(match, winProb),
          bankroll_advice: bankrollService.calculateOptimalBet(winProb, match.odds_home || 2.0),
          is_confirmed: (pythonResult?.xgboost_confidence || pythonResult?.confidence || 0) >= 0.85,
          trap_alert: trapData?.isTrap || false,
          trap_details: trapData?.msg || null,
          master_v20: await correlationEngine.analyze({
            ...match,
            enriched: {
              winner,
              winnerProbability: winProb,
              home_win_probability: pythonResult?.home_win_probability || winProb * 100,
              away_win_probability: pythonResult?.away_win_probability || 0,
              draw_probability: pythonResult?.draw_probability || 0,
            },
          }),
        },
      }

      // ── [QUANT ENGINE] Apply Institutional EV+ & Kelly Math ──
      try {
        const QuantService = require('../services/quantService')
        Object.assign(enrichedMatch, QuantService.injectFinancials(enrichedMatch))
      } catch (e) {
        console.error(`❌ [QUANT] Failed to calculate EV for ${match.id}: ${e.message}`)
      }

      return enrichedMatch
    } catch (error) {
      trace.error('Global', error.message, error.stack)
      return { ...match, trace: trace.getSummary(), under_analysis: true }
    }
  }

  /**
   * Execute JS QuantumQuantEngine PRIMARY, Python/FastAPI optional enrichment
   */
  async getAnalyticalPrediction(match, timeoutMs = null) {
    try {
      const league = match.league || match.tournament || 'Unknown'
      match.adaptive_weights = await adaptiveLearningEngine.getWeights(league)
      match.adaptive_confidence_adj = await adaptiveLearningEngine.getConfidenceAdjustment(league)
    } catch (e) {
      /* ignore adaptive errors */
    }

    // V553 PREMIUM (XGBoost) — PRIMARY
    const v553Result = await this._tryV553(match, timeoutMs)
    let result
    if (v553Result.success) {
      result = v553Result
    } else {
      // JS ENGINE — fallback si V553 down
      const xgResult = StatisticalEngine.getMatchXG(match)
      const xgH = xgResult.h,
        xgA = xgResult.a
      const quantResult = QuantumQuantEngine.analyze(match, xgH, xgA)
      result = {
        success: true,
        home_win_probability: quantResult.markets.match_result['1'].prob * 100,
        draw_probability: quantResult.markets.match_result['X'].prob * 100,
        away_win_probability: quantResult.markets.match_result['2'].prob * 100,
        expected_score: quantResult.expected_score,
        verdict: quantResult.risk_label,
        prediction: quantResult.main_pick,
        confidence: quantResult.confidence,
        xgboost_confidence: (quantResult.confidence || 50) / 100,
        power_score: quantResult.confidence,
        quantum: quantResult,
      }
    }

    // Gemma 4 (local) tactical briefing enrichment
    try {
      const Gemma4Service = require('../services/gemma4Service')
      if (!Gemma4Service.isAvailable()) {
        logger.debug('[GEMMA4] Skipped — service unavailable.')
      } else {
        const briefing = await Gemma4Service.analyzePreMatchVIP(match)
        if (briefing) {
          result.tactical_brief = briefing.match_overview
          result.deep_analysis = {
            match_overview: briefing.match_overview,
            tactical_keyup: briefing.tactical_keyup,
            motivation_verdict: briefing.motivation_verdict,
            exact_score_prediction: briefing.exact_score_prediction,
            risk_mitigation: briefing.risk_mitigation,
          }
        }
      }
    } catch (e) {
      logger.warn(`[GEMMA4] Failed: ${e.message}`)
    }

    // Python/FastAPI optional enrichment — skip if V553 already succeeded (avoids double HTTP call)
    if (!result.v553) {
      try {
        const py = await this.pythonService.predict(match, timeoutMs || 180000)
        if (py && py.success !== false) {
          result.python_enriched = true
          if (py.home_win_probability !== undefined)
            result.home_win_probability = py.home_win_probability
          if (py.draw_probability !== undefined) result.draw_probability = py.draw_probability
          if (py.away_win_probability !== undefined)
            result.away_win_probability = py.away_win_probability
          if (py.expected_score) result.expected_score = py.expected_score
          if (py.verdict) result.verdict = py.verdict
          if (py.ai_source) result.ai_source = py.ai_source
          if (py.xgboost_confidence) result.xgboost_confidence = py.xgboost_confidence
          if (py.confidence) result.confidence = py.confidence
        }
      } catch (e) {
        logger.warn(`[FASTAPI] predict failed: ${e.message}`)
      }
    } // end if (!result.v553)

    return result
  }

  async _tryV553(match, timeoutMs) {
    try {
      // Skip V553 for seed/emergency matches — no real ML data to process
      if (match.source === 'seed' || match.source === 'emergency') {
        return { success: false, source: 'seed_skip' }
      }

      // Pre-fetch SofaScore team data if not already populated
      if (
        !match._sofaTeamDataFetched &&
        (match.home_team_id ||
          match._homeTeamId ||
          match.sofascore_id ||
          (typeof match.id === 'string' && match.id.startsWith('sofascore_')))
      ) {
        await this._fetchSofaTeamData(match)
      }

      // Retry up to 2 times with 1s delay
      let lastError = null
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 1000))
        }

        const pythonService = require('../core/pythonService')
        const pyMatch = {
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          league: match.league || match.tournament || 'International',
          tournament_name: match.tournament_name || match.category_name || '',
          match_date: match.match_date || '',
          startTimestamp: match.startTimestamp || 0,
          odds_home: match.odds_home,
          odds_draw: match.odds_draw,
          odds_away: match.odds_away,
          odds_home_open: match.odds_home_open || match.odds_home,
          teamStats: match.teamStats || null,
          form_context: match.form_context || null,
          historical_context: match.historical_context || null,
          h2h_data: match.h2h_data || null,
          news_data: match.news_data || null,
          news_sentiment: match.news_sentiment || 0,
          stats_blob: match.stats_blob || null,
          player_ratings_home: match.player_ratings_home || null,
          player_ratings_away: match.player_ratings_away || null,
          weather_temp: match.weather_temp || null,
          weather_desc: match.weather_desc || null,
          weather_humidity: match.weather_humidity || null,
          home_possession: match.home_possession || null,
          away_possession: match.away_possession || null,
          home_shots: match.home_shots || null,
          away_shots: match.away_shots || null,
          home_shots_on_target: match.home_shots_on_target || null,
          away_shots_on_target: match.away_shots_on_target || null,
          home_corners: match.home_corners || null,
          away_corners: match.away_corners || null,
          country_iso: match.country_iso || null,
          category_name: match.category_name || null,
          task: 'PREDICTION',
        }
        const py = await pythonService.predict(pyMatch, timeoutMs || 30000)
        if (py && py.success) {
          const labelMap = {
            1: '1',
            X: 'X',
            2: '2',
            Home: '1',
            Draw: 'X',
            Away: '2',
            'Home Win': '1',
            'Away Win': '2',
          }
          const pyProbs = [
            { label: '1', prob: parseFloat(py.home_win_probability || py.home_win_prob || 0) },
            { label: 'X', prob: parseFloat(py.draw_probability || py.draw_prob || 0) },
            { label: '2', prob: parseFloat(py.away_win_probability || py.away_win_prob || 0) },
          ]
          const bestPy = pyProbs.sort((a, b) => b.prob - a.prob)[0]
          const label = bestPy && bestPy.prob > 0 ? bestPy.label : 'X'
          const conf = py.confidence || py.surgical_confidence || 0
          return {
            success: true,
            v553: true,
            home_win_probability: py.home_win_probability || py.home_win_prob || 0,
            draw_probability: py.draw_probability || py.draw_prob || 0,
            away_win_probability: py.away_win_probability || py.away_win_prob || 0,
            expected_score: py.expected_score || '0 - 0',
            prediction: label,
            verdict: py.verdict || (label === '1' ? 'Home' : label === 'X' ? 'Draw' : 'Away'),
            confidence: conf,
            xgboost_confidence: conf / 100,
            power_score: py.power_score || conf,
            model: 'V553_PREMIUM',
            ai_source: py.ai_source || 'V553_PREMIUM',
            ou_25_prob: py.ou_25_prob ? Math.round(py.ou_25_prob * 100) : undefined,
            btts_prob: py.btts_prob ? Math.round(py.btts_prob * 100) : undefined,
            surgical_market: py.surgical_market,
            surgical_confidence: py.surgical_confidence,
            backup_market: py.backup_market,
            dc_probs: py.dc_probs,
            dnb_probs: py.dnb_probs,
            kelly_stake: py.kelly_stake,
            v22_success_rate: py.v22_success_rate,
            precision_bets: py.precision_bets,
            main_predictions: py.main_predictions,
            strategic_brief: py.strategic_brief,
            is_confirmed: py.is_confirmed,
            py_full: py,
          }
        }
        // If we get here, this attempt failed — log and retry
        if (py && py.error) {
          lastError = py.error
          logger.warn(`[V553] Attempt ${attempt + 1}/2 failed: ${py.error}`)
        } else {
          lastError = 'unknown'
        }
      } // end retry loop

      logger.warn(`[V553] All retries exhausted: ${lastError}`)
      return { success: false, fallback: true }
    } catch (e) {
      logger.warn(`[V553] Bridge error after retries: ${e.message}`)
      return { success: false, fallback: true }
    }
  }

  /**
   * Request prediction from XGBoost Flask Bridge
   */
  getXGBoostPrediction(match, newsData = null) {
    return new Promise((resolve) => {
      const data = JSON.stringify({
        id: match.id,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        teamStats: match.teamStats,
        newsData: newsData,
        form_context: match.form_context,
        historical_context: match.historical_context,
        league: match.tournament || match.league || '',
        tournament: match.category || '',
        startTimestamp: match.startTimestamp || 0,
      })

      const options = {
        hostname: '127.0.0.1',
        port: 8000,
        path: '/predict',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 5000,
      }

      const req = http.request(options, (res) => {
        let chunks = ''
        res.on('data', (d) => {
          chunks += d
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(chunks))
          } catch (e) {
            resolve({ success: false, error: 'JSON Parse Error' })
          }
        })
      })

      req.on('error', (e) => {
        resolve({ success: false, error: e.message })
      })

      req.write(data)
      req.end()
    })
  }

  /**
   * Fetch season statistics for one team from Sofascore
   */
  async fetchSofaTeamStats(teamId, uniqueTournamentId, seasonId) {
    try {
      const url = `${SOFA_API}/team/${teamId}/unique-tournament/${uniqueTournamentId}/season/${seasonId}/statistics/overall`
      const res = await axiosModule.get(url, { headers: SOFA_HEADERS, timeout: 5000 })
      const s = res.data?.statistics
      if (!s) return null

      const mp = s.matches || s.matchesPlayed || 0
      if (!mp || mp === 0) return null

      return {
        avgGoalsScored: +(s.goalsScored / mp).toFixed(2),
        avgGoalsConceded: +(s.goalsConceded / mp).toFixed(2),
        avgShotsOnTarget: +(s.shotsOnTarget / mp).toFixed(2),
        avgCorners: +((s.corners || s.cornerKicks || 0) / mp).toFixed(2),
        avgBigChances: +((s.bigChances || 0) / mp).toFixed(2),
        avgPossession: +(s.averageBallPossession || 50).toFixed(1),
        matchesPlayed: mp,
      }
    } catch (e) {
      return null
    }
  }

  getFallbackPrediction(match) {
    // [SAFETY FIX] Stop generating fake predictions based on team name length.
    // Return a clear error state so the UI knows the AI is offline.
    return {
      prediction: 'UNDER ANALYSIS',
      probability: 0,
      confidence: 'none',
      error: 'AI_OFFLINE',
    }
  }

  runBacktestSimulatorFallback(match) {
    // [SAFETY FIX] Prevent "Fortune Telling" fallback.
    return {
      success: false,
      ai_source: 'NONE',
      error: 'AI ENGINE OFFLINE',
      home_win_probability: 0,
      away_win_probability: 0,
      draw_probability: 0,
      verdict: 'UNDER ANALYSIS',
      power_score: 0,
      main_predictions: [],
    }
  }

  /**
   * Generate deterministic synthetic odds from team names when no bookmaker odds exist.
   * Uses a simple hash to create unique-but-consistent per-match differentiation.
   */
  _generateSyntheticOdds(homeTeam, awayTeam, league) {
    const str = `${homeTeam || 'Home'}_vs_${awayTeam || 'Away'}_${league || ''}`
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i)
      hash = (hash << 5) - hash + ch
      hash = hash & hash
    }
    const seed = Math.abs(hash) / 2147483647
    const seed2 = ((hash >> 8) & 0xff) / 255

    // League-based base adjustment: top leagues have wider differentiation
    const leagueLower = (league || '').toLowerCase()
    let baseRange = 0.5
    if (
      /champions league|premier|liga|laliga|bundesliga|serie a|ligue 1|eredivisie/i.test(
        leagueLower
      )
    ) {
      baseRange = 0.6
    } else if (/championship|serie b|ligue 2|a league|mls|botola|allsvenskan/i.test(leagueLower)) {
      baseRange = 0.45
    } else {
      baseRange = 0.35
    }

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

  predictCorners(match, winnerPrediction) {
    return StatisticalEngine.predictCorners(match, winnerPrediction.probability)
  }

  predictCards(match) {
    return StatisticalEngine.predictCards(match)
  }

  predictGoals(match, winnerPrediction) {
    return StatisticalEngine.predictGoals(match, winnerPrediction.probability)
  }

  _poissonProb(lambda, k) {
    return StatisticalEngine.getPoissonProb(lambda, k)
  }

  _getMatchXG(m) {
    return StatisticalEngine.getMatchXG(m)
  }

  _isLowData(m) {
    const league = (m.league || '').toLowerCase()
    if (
      league.includes('friendly') ||
      league.includes('cup') ||
      league.includes('supercup') ||
      league.includes('super_cup') ||
      league.includes('charity') ||
      league.includes('club friendly') ||
      league.includes('friendlies')
    )
      return true
    if (parseInt(m.insufficient_data) === 1) return true
    return false
  }

  async _tryBayesianLowData(m) {
    try {
      const http = require('http')
      const payload = JSON.stringify({
        home_team: m.homeTeam,
        away_team: m.awayTeam,
        league: m.league || '',
        tournament_name: m.tournament_name || m.category_name || '',
        start_timestamp: m.startTimestamp || 0,
        home_team_id: m.home_team_id || 0,
        away_team_id: m.away_team_id || 0,
      })
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          req.destroy()
          resolve(null)
        }, 6000)
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: 8000,
            path: '/bayesian/predict',
            method: 'POST',
            agent: false,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            },
            timeout: 5000,
          },
          (res) => {
            let data = ''
            res.on('data', (d) => (data += d))
            res.on('end', () => {
              clearTimeout(timer)
              try {
                const parsed = JSON.parse(data)
                if (parsed && parsed.success) {
                  const bayes_home =
                    parseFloat(parsed.home_win_probability ?? parsed.home_win ?? 0) * 100
                  const bayes_draw = parseFloat(parsed.draw_probability ?? parsed.draw ?? 0) * 100
                  const bayes_away =
                    parseFloat(parsed.away_win_probability ?? parsed.away_win ?? 0) * 100
                  resolve({
                    home_win_probability: bayes_home,
                    draw_probability: bayes_draw,
                    away_win_probability: bayes_away,
                    expected_score: parsed.expected_score,
                    btts_prob: parseFloat(parsed.btts_prob ?? parsed.btts_yes ?? 0) * 100,
                    ou_25_prob: parseFloat(parsed.ou_25_prob ?? parsed.over_25 ?? 0) * 100,
                    confidence: parseFloat(parsed.confidence ?? 0) * 100,
                    ai_source: 'BAYESIAN_LOWDATA',
                  })
                } else {
                  resolve(null)
                }
              } catch (_) {
                resolve(null)
              }
            })
          }
        )
        req.on('error', () => {
          clearTimeout(timer)
          resolve(null)
        })
        req.on('timeout', () => {
          req.destroy()
          clearTimeout(timer)
          resolve(null)
        })
        req.write(payload)
        req.end()
      })
    } catch (_) {
      return null
    }
  }

  /**
   * Fast JS-only enrichment for bulk operations.
   * Uses real Poisson distribution based on match-specific xG data.
   * No Python subprocess needed.
   */
  async fastEnrichMatch(match, opts = {}) {
    try {
      const m = { ...match }
      const skipBayesian = opts.skipBayesian === true

      // ── FETCH ODDS (critical for odds-implied xG differentiation) ──
      if (!m.odds_home || !m.odds_draw || !m.odds_away) {
        try {
          const dataFusionService = require('../services/dataFusionService')
          const liveOdds = await dataFusionService.fetchOdds(m)
          if (liveOdds) {
            m.odds_home = liveOdds.home
            m.odds_draw = liveOdds.draw
            m.odds_away = liveOdds.away
            // Only REAL bookmaker quotes count as real odds. Probability-derived
            // quotes (xG/prediction-margin) are treated as synthetic — they must
            // never gate value/honesty as if they were bookmaker data.
            if (liveOdds.bookmaker === true) {
              m._oddsWereFetched = true
            } else {
              m._oddsAreSynthetic = true
            }
          }
        } catch (_) {
          /* odds fetch failed — continue without odds */
        }
      } else {
        m._oddsWereFetched = true
      }

      // ── SYNTHETIC ODDS FALLBACK (per-match differentiation when no real odds) ──
      if (!m.odds_home || !m.odds_draw || !m.odds_away) {
        const str = `${m.homeTeam || 'Home'}_vs_${m.awayTeam || 'Away'}_${m.league || ''}`
        let hash = 0
        for (let i = 0; i < str.length; i++) {
          hash = (hash << 5) - hash + str.charCodeAt(i)
          hash = hash & hash
        }
        const seed = Math.abs(hash) / 2147483647
        const seed2 = ((hash >> 8) & 0xff) / 255
        const baseRange = 0.45
        const hp = 0.3 + seed * 0.25 // narrower range for more realistic odds
        const dp = 0.18 + seed2 * 0.16
        const ap = Math.max(0.08, 1 - hp - dp)
        m.odds_home = parseFloat((1.05 / hp).toFixed(2))
        m.odds_draw = parseFloat((1.05 / dp).toFixed(2))
        m.odds_away = parseFloat((1.05 / ap).toFixed(2))
        m._oddsAreSynthetic = true
        m.insufficient_data = 1
      }

      // ── BAYESIAN LOW-DATA RESCUE ──
      if (!skipBayesian && this._isLowData(m)) {
        const bayesian = await this._tryBayesianLowData(m)
        if (
          bayesian &&
          (parseFloat(bayesian.home_win_probability) > 0 ||
            parseFloat(bayesian.away_win_probability) > 0)
        ) {
          const bh = parseFloat(bayesian.home_win_probability) || 0
          const bd = parseFloat(bayesian.draw_probability) || 0
          const ba = parseFloat(bayesian.away_win_probability) || 0
          const tot = bh + bd + ba > 0 ? bh + bd + ba : 1
          const hp = bh / tot,
            dp = bd / tot,
            ap = ba / tot
          const bayesMarkets = {
            match_result: {
              1: { prob: hp, odds: null, ev: 0 },
              X: { prob: dp, odds: null, ev: 0 },
              2: { prob: ap, odds: null, ev: 0 },
            },
            double_chance: {
              '1X': { prob: hp + dp, odds: null, ev: 0 },
              X2: { prob: dp + ap, odds: null, ev: 0 },
              12: { prob: hp + ap, odds: null, ev: 0 },
            },
          }
          return {
            ...m,
            ...bayesian,
            success: true,
            prediction: bh > ba ? '1' : '2',
            insufficient_data: 1,
            quant: {
              main_pick: bh > ba ? '1' : '2',
              ev_score: '0.00',
              risk_label: 'STABLE',
              market_strength: 'NORMAL',
              markets: bayesMarkets,
              probs: {
                btts: Math.round(parseFloat(bayesian.btts_prob) || 0),
                over25: Math.round(parseFloat(bayesian.ou_25_prob) || 0),
                ht_goal: 50,
              },
            },
          }
        }
      }

      // ── SOFASCORE TEAM DATA (form, xG) ──
      const hasLiveScoreId = typeof m.id === 'string' && m.id.startsWith('livescore_')
      if (
        !m._sofaTeamDataFetched &&
        (m.home_team_id ||
          m._homeTeamId ||
          m.sofascore_id ||
          hasLiveScoreId ||
          (typeof m.id === 'string' && m.id.startsWith('sofascore_')))
      ) {
        await this._fetchSofaTeamData(m)
        // Use team form xG as fallback when DB xG is missing
        if (!parseFloat(m.home_xg) > 0.5) {
          const ts = m.teamStats
          if (ts?.home?.avgXgFor > 0) m.home_xg = ts.home.avgXgFor
          if (ts?.away?.avgXgFor > 0) m.away_xg = ts.away.avgXgFor
        }
      }

      // ── EXTERNAL XG FETCH ──
      // Try multiple external sources when DB xG is missing or stale
      const hasRealXg = parseFloat(m.home_xg) > 0.5 && parseFloat(m.away_xg) > 0.5
      if (!hasRealXg) {
        // 1. Sofascore xG (High accuracy, free)
        if (m.sofascore_id) {
          try {
            const sofaXgSvc = require('../services/sofascoreXgService')
            const sofaData = await sofaXgSvc.fetchMatchXg(m.sofascore_id)
            if (sofaData) {
              m.home_xg = sofaData.home_xg || m.home_xg
              m.away_xg = sofaData.away_xg || m.away_xg
            }
          } catch (_) {
            /* Sofascore fetch failed */
          }
        }

        // 2. BSD prediction API (via bsd_match_id)
        if (!(parseFloat(m.home_xg) > 0.5 && parseFloat(m.away_xg) > 0.5) && m.bsd_match_id) {
          try {
            const bsdService = require('../services/bsdService')
            if (bsdService.isAvailable()) {
              const pred = await bsdService.fetchPredictions(m.bsd_match_id)
              if (pred && pred.xg) {
                m.home_xg = pred.xg.home || m.home_xg
                m.away_xg = pred.xg.away || m.away_xg
              }
            }
          } catch (_) {
            /* BSD prediction fetch failed */
          }
        }

        // 3. API-Football predictions (via fixtureId in fullData)
        if (!(parseFloat(m.home_xg) > 0.5 && parseFloat(m.away_xg) > 0.5)) {
          try {
            const fd = typeof m.fullData === 'string' ? JSON.parse(m.fullData) : m.fullData || {}
            const fixtureId = fd.fixtureId
            if (fixtureId) {
              const afService = require('../services/apifootballService')
              if (afService.isAvailable()) {
                const preds = await afService.fetchPredictions(fixtureId)
                if (preds && preds.length > 0 && preds[0].predictions) {
                  const p = preds[0].predictions
                  if (p.goals_home != null) m.home_xg = parseFloat(p.goals_home) || m.home_xg
                  if (p.goals_away != null) m.away_xg = parseFloat(p.goals_away) || m.away_xg
                }
              }
            }
          } catch (_) {
            /* API-Football prediction fetch failed */
          }
        }

        // 4. Big Balls Data stats (via bigballs.matchId in fullData)
        if (!(parseFloat(m.home_xg) > 0.5 && parseFloat(m.away_xg) > 0.5)) {
          try {
            const fd = typeof m.fullData === 'string' ? JSON.parse(m.fullData) : m.fullData || {}
            const bbMatchId = fd.bigballs?.matchId
            if (bbMatchId) {
              const bbsService = require('../services/bigBallsDataService')
              if (bbsService.isAvailable()) {
                const stats = await bbsService.getMatchStats(bbMatchId)
                if (stats) {
                  const xgH = stats.h2h?.home?.xg || stats.team?.home?.xg || stats.home_xg
                  const xgA = stats.h2h?.away?.xg || stats.team?.away?.xg || stats.away_xg
                  if (xgH != null && xgH > 0.1) m.home_xg = xgH
                  if (xgA != null && xgA > 0.1) m.away_xg = xgA
                }
              }
            }
          } catch (_) {
            /* Big Balls Data stats fetch failed */
          }
        }

        // 5. FutPythonTrader data (Comprehensive match info)
        if (!(parseFloat(m.home_xg) > 0.5 && parseFloat(m.away_xg) > 0.5)) {
          try {
            const fpService = require('../services/futpythonService')
            if (fpService.isAvailable()) {
              const fpData = await fpService.enrichMatch(m)
              if (fpData) {
                m.fullData =
                  typeof m.fullData === 'string' ? JSON.parse(m.fullData) : m.fullData || {}
                m.fullData.futpython = fpData
                m.fullData = JSON.stringify(m.fullData)
              }
            }
          } catch (_) {
            /* FutPython fetch failed */
          }
        }
      }

      // ── 1. V553 PREMIUM (XGBoost) — PRIMARY ──
      const v553 = await this._tryV553(m)
      let quantResult, aiSource, xgH, xgA, probs
      // Always compute JS engine xG for fallback use
      if (m.odds_home && m.odds_draw && m.odds_away) {
        const derivedOdds = StatisticalEngine.deriveXgFromOdds(m)
        if (derivedOdds) {
          xgH = derivedOdds.h
          xgA = derivedOdds.a
        }
      }
      if (!xgH) {
        const xg = this._getMatchXG(m)
        xgH = xg.h
        xgA = xg.a
      }
      quantResult = QuantumQuantEngine.analyze(m, xgH || 1.0, xgA || 1.0)

      // 🧠 [FEATURE ENGINE] Apply free features (home advantage, rest days, form, Elo)
      const adjusted = featureEngineer.applyFeatures(m, xgH || 1.0, xgA || 1.0)
      if (adjusted.xgH !== (xgH || 1.0) || adjusted.xgA !== (xgA || 1.0)) {
        quantResult = QuantumQuantEngine.analyze(m, adjusted.xgH, adjusted.xgA)
      }
      if (v553.success) {
        // Check if V553 returned usable non-zero probabilities
        const pyHome = parseFloat(v553.home_win_probability || v553.home_win_prob || 0)
        const pyDraw = parseFloat(v553.draw_probability || v553.draw_prob || 0)
        const pyAway = parseFloat(v553.away_win_probability || v553.away_win_prob || 0)
        const v553HasRealProbs = pyHome + pyDraw + pyAway > 5
        if (v553HasRealProbs) {
          aiSource = 'V553_PREMIUM'
          const pyProbs = [
            { label: '1', prob: pyHome },
            { label: 'X', prob: pyDraw },
            { label: '2', prob: pyAway },
          ]
          const bestPy = pyProbs.sort((a, b) => b.prob - a.prob)[0]
          const v553Prediction = bestPy && bestPy.prob > 0.4 ? bestPy.label : null
          if (v553Prediction && v553Prediction !== 'X') quantResult.main_pick = v553Prediction
          quantResult.expected_score = v553.expected_score || quantResult.expected_score
          quantResult.confidence = v553.confidence
          probs = { h: pyHome, d: pyDraw, a: pyAway }
        } else {
          // V553 returned 0/0/0 — fall back to JS engine probs
          aiSource = 'TITANIUM_QUANT_V4'
          probs = {
            h: quantResult.markets.match_result['1'].prob,
            d: quantResult.markets.match_result['X'].prob,
            a: quantResult.markets.match_result['2'].prob,
          }
        }
      } else {
        // V553 ML failed — fallback to JS engine
        aiSource = 'TITANIUM_QUANT_V4'
        probs = {
          h: quantResult.markets.match_result['1'].prob,
          d: quantResult.markets.match_result['X'].prob,
          a: quantResult.markets.match_result['2'].prob,
        }
      }
      // 🧠 [BASE SOLID INJECTOR] Home/Away domine les 2 autres par ≥25pp → pick direct
      const hPct = (probs.h || 0) * 100
      const dPct = (probs.d || 0) * 100
      const aPct = (probs.a || 0) * 100
      const hDominant = hPct - dPct >= 25 && hPct - aPct >= 25
      const aDominant = aPct - dPct >= 25 && aPct - hPct >= 25
      const baseSolidMargin = Math.max(
        hDominant ? hPct - Math.max(dPct, aPct) : 0,
        aDominant ? aPct - Math.max(dPct, hPct) : 0
      )
      if (hDominant || aDominant) {
        quantResult.main_pick = hDominant ? '1' : '2'
      } else {
        if (quantResult.main_pick === '1') quantResult.main_pick = '1X'
        if (quantResult.main_pick === '2') quantResult.main_pick = 'X2'
      }

      // ── 2. DETECT INSUFFICIENT DATA ──
      // Real odds proof = non-synthetic odds persisted in indexed columns
      // (_oddsWereFetched is a memory-only flag, absent after DB reload, so the
      // persisted columns themselves are the source of truth). Synthetic odds are
      // NEVER written to columns, so column values imply real bookmaker odds.
      const hasRealOdds =
        !m._oddsAreSynthetic &&
        parseFloat(m.odds_home) > 0 &&
        parseFloat(m.odds_draw) > 0 &&
        parseFloat(m.odds_away) > 0
      const hasOdds = parseFloat(m.odds_home) > 0 && parseFloat(m.odds_away) > 0
      const hasXg = parseFloat(m.home_xg) > 0.3 && parseFloat(m.away_xg) > 0.3
      const hasForm = parseFloat(m.home_form_pts) > 0 || parseFloat(m.away_form_pts) > 0
      const v553IsDefault =
        v553.success &&
        !parseFloat(v553.home_win_probability) &&
        !parseFloat(v553.away_win_probability)
      // Honesty: synthetic odds (hashed names) do NOT count as real bookmaker data.
      // A match is "insufficient" only when there is NO usable signal to model a probability.
      // The Poisson engine derives valid per-league probabilities even without xG/form/odds
      // (league base-xG defaults). We trust those numbers AS A MODEL OUTPUT — but they are
      // marked as model probabilities and NEVER carry invented odds/value (handled below).
      // Require a non-degenerate probability signal: a clear top pick with a real margin.
      const sumProbs = (probs.h || 0) + (probs.d || 0) + (probs.a || 0)
      const topModel = Math.max(probs.h || 0, probs.d || 0, probs.a || 0)
      const secondModel = [probs.h, probs.d, probs.a].sort((a, b) => b - a)[1] || 0
      const hasModelSignal = sumProbs > 1.5 && topModel - secondModel >= 0.06 && topModel >= 0.34
      const insufficient = hasRealOdds ? 0 : !hasModelSignal ? 1 : 0

      // ── 2.5 CONFIDENCE SCORER (Force du Pronostic) ──
      const sortedProbs = [
        { label: '1', prob: probs.h },
        { label: 'X', prob: probs.d },
        { label: '2', prob: probs.a },
      ].sort((a, b) => b.prob - a.prob)
      const topPick = sortedProbs[0]
      const secondPick = sortedProbs[1]
      const mainPick = quantResult.main_pick || topPick.label
      const marketType = ['1X', 'X2', '12'].includes(mainPick)
        ? 'DC'
        : ['O2.5', 'U2.5'].includes(mainPick)
          ? 'OU'
          : '1X2'

      const csResult = confidenceScorer.computeConfidence({
        mainPick,
        topProb: topPick.prob,
        secondProb: secondPick.prob,
        baseSolidMargin,
        insufficientData: insufficient,
        league: m.league || '',
        marketType,
      })

      // override raw quant confidence with calibrated score
      quantResult.confidence = csResult.confidence
      quantResult._confidence_breakdown = csResult.breakdown
      quantResult._confidence_margin_pct = csResult.breakdown.finalMarginPct

      // ── 3. FINAL ASSEMBLY ──
      if (insufficient && quantResult.risk_label === 'SAFE') quantResult.risk_label = 'STABLE'
      const resultData = {
        ...m,

        success: true,
        insufficient_data: insufficient,
        ai_source: aiSource,
        v553: !!v553.success,
        expected_score: quantResult.expected_score,
        home_win_probability: probs.h * 100,
        draw_probability: probs.d * 100,
        away_win_probability: probs.a * 100,
        btts_prob: quantResult.probs.btts,
        ou_25_prob: quantResult.probs.over25,
        ou_market: (() => {
          const op = quantResult.probs.over25 || 0
          const ovPct = parseFloat(op)
          const dir = ovPct > 50 ? 'OVER' : 'UNDER'
          const prec = Math.round(ovPct > 50 ? ovPct : 100 - ovPct)
          return `${dir} 2.5 (${prec}% Precision)`
        })(),
        draw_value_bet: (() => {
          const mp = quantResult.main_pick
          if (mp !== 'X' && mp !== '1X' && mp !== 'X2' && mp !== '12') return false
          const ev = parseFloat(quantResult.ev_score || 0)
          const drawOdds = parseFloat(m.odds_draw)
          if (ev < 0.2 || !drawOdds || drawOdds <= 3.2) return false
          return true
        })(),
        base_solid_margin: parseFloat(baseSolidMargin.toFixed(1)),
        ht_goal_prob: quantResult.probs.ht_goal,
        xgboost_confidence: v553.success ? v553.confidence : 0,

        // Professional Quant Metrics
        quant: quantResult,
        edge_score: quantResult.edge_score,
        massive_edge: quantResult.massive_edge,
        signal_strength: quantResult.signal_strength,

        confidence: quantResult.confidence,
        risk_score: 100 - quantResult.confidence,
        verdict: quantResult.risk_label,
        prediction: quantResult.main_pick,

        // UI Predictions Array (for MatchRow)
        predictions: [
          { label: '🎯 MAIN', val: quantResult.main_pick, ev: quantResult.ev_score },
          {
            label: quantResult.massive_edge ? '🔥 MASSIVE EDGE' : '🧠 EDGE',
            val: quantResult.edge_score,
            color: quantResult.massive_edge
              ? '#fbbf24'
              : parseFloat(quantResult.edge_score) > 0.05
                ? '#f59e0b'
                : '#6b7280',
            pulse: quantResult.massive_edge ? true : false,
          },
          { label: '📈 2ND', val: quantResult.secondary_pick },
          { label: '🛡️ RISK', val: quantResult.risk_label },
        ],

        enriched: {
          ...m.enriched,
          winner: quantResult.main_pick,
          confidence: quantResult.confidence,
          is_confirmed: quantResult.confidence > 80,
          verdict: quantResult.risk_label,
          main_predictions: quantResult.all_picks.map((p) => ({
            label: p.label,
            val: `${(p.prob * 100).toFixed(0)}% (EV: ${p.ev.toFixed(2)})`,
          })),
        },
      }

      // Embed confidence breakdown in fullData for API persistence
      try {
        const fd =
          typeof resultData.fullData === 'string'
            ? JSON.parse(resultData.fullData)
            : resultData.fullData || {}
        fd._confidence_breakdown = quantResult._confidence_breakdown
        fd._confidence_score = quantResult.confidence
        fd._base_solid_margin = baseSolidMargin
        resultData.fullData = JSON.stringify(fd)
      } catch (_) {}

      // Gemma 4 tactical briefing (fire-and-forget — non-blocking)
      const g4Service = require('../services/gemma4Service')
      g4Service
        .analyzePreMatchVIP(m)
        .then((briefing) => {
          if (briefing) {
            resultData.tactical_brief = briefing.match_overview
            resultData.deep_analysis = {
              match_overview: briefing.match_overview,
              tactical_keyup: briefing.tactical_keyup,
              motivation_verdict: briefing.motivation_verdict,
              exact_score_prediction: briefing.exact_score_prediction,
              risk_mitigation: briefing.risk_mitigation,
            }
          }
        })
        .catch(() => {})

      // ULTIMATE FALLBACK: ensure non-zero predictions always
      const hWP = parseFloat(resultData.home_win_probability || 0)
      const aWP = parseFloat(resultData.away_win_probability || 0)
      if (!hWP || !aWP || isNaN(hWP) || isNaN(aWP)) {
        try {
          const fb = this._buildOfflineState(m)
          resultData.home_win_probability = fb.home_win_probability
          resultData.draw_probability = fb.draw_probability
          resultData.away_win_probability = fb.away_win_probability
          resultData.expected_score = fb.expected_score
          resultData.btts_prob = fb.btts_prob
          resultData.ou_25_prob = fb.ou_25_prob
          resultData.ai_source = 'FALLBACK_ENGINE'
          resultData.quant = fb.quant
        } catch (_) {
          resultData.home_win_probability = 30
          resultData.draw_probability = 25
          resultData.away_win_probability = 25
          resultData.btts_prob = 40
          resultData.ou_25_prob = 40
          resultData.ai_source = 'HARD_FALLBACK'
          resultData.insufficient_data = 1
        }
      }

      // ── HONESTY GATE: insufficient matches MUST NOT carry fake picks / odds / value ──
      if (insufficient || (m._oddsAreSynthetic && !hasRealOdds)) {
        if (m._oddsAreSynthetic) {
          resultData.odds_home = null
          resultData.odds_draw = null
          resultData.odds_away = null
          if (resultData.odds_source) resultData.odds_source = 'synthetic'
        }
        resultData.prediction = null
        resultData.verdict = 'PENDING'
        resultData.risk_label = 'PENDING'
        resultData.quant.main_pick = null
        resultData.quant.risk_label = 'PENDING'
        resultData.quant.all_picks = []
        resultData.quant.markets = {}
        resultData.quant.market_odds = null
        resultData.quant.ev_score = 0
        resultData.quant.edge_score = 0
        resultData.quant.massive_edge = false
        resultData.draw_value_bet = false
        resultData.predictions = []
        resultData.confidence = Math.min(resultData.confidence || 0, 40)
        if (resultData.enriched) {
          resultData.enriched.winner = null
          resultData.enriched.main_predictions = []
          resultData.enriched.verdict = 'PENDING'
        }
        resultData.sufficient = false
      } else {
        resultData.sufficient = true
        // HONESTY: without REAL bookmaker odds there is no way to compute value/edge.
        // We keep the model's probability pick and verdict, but the value-based metrics
        // MUST stay neutral — we never present invented odds or value.
        if (!hasRealOdds) {
          resultData.quant.ev_score = 0
          resultData.quant.edge_score = 0
          resultData.quant.massive_edge = false
          // market_odds is left at its computed value (undefined when no bookmaker) so
          // the Dashboard does not treat the match as "insufficient" — it shows the
          // model pick + probabilities, without any bookmaker odds.
          resultData.draw_value_bet = false
          resultData.odds_home = null
          resultData.odds_draw = null
          resultData.odds_away = null
          if (resultData.odds_source) resultData.odds_source = 'model_league'
        }
      }

      return resultData
    } catch (err) {
      logger.error(`[Quant Engine] Overhaul Error: ${err.message}`)
      return this._buildOfflineState(match)
    }
  }

  _buildOfflineState(m) {
    // Use league baseline xG + team-name dispersion instead of hard zeros
    const leagueBase = StatisticalEngine._getLeagueBaseXG(m.league)
    const strToHash = (m.id || '') + (m.homeTeam || '') + (m.awayTeam || '') + 'baseline'
    let numHash = 0
    for (let i = 0; i < strToHash.length; i++) numHash += strToHash.charCodeAt(i)
    const noise = ((numHash % 100) - 50) / 100
    const xgH = Math.max(0.4, leagueBase.h * (1 + noise * 0.15))
    const xgA = Math.max(0.4, leagueBase.a * (1 - noise * 0.1))
    let hPct, dPct, aPct
    let probs = null
    try {
      probs = StatisticalEngine.calculatePoissonProbs(xgH, xgA, m)
      hPct = +(probs.win.home * 100).toFixed(1)
      dPct = +(probs.win.draw * 100).toFixed(1)
      aPct = +(probs.win.away * 100).toFixed(1)
      if (isNaN(hPct) || isNaN(aPct)) throw new Error('NaN probs')
    } catch (_) {
      hPct = 35
      dPct = 28
      aPct = 27
    }
    const mainPick = hPct >= aPct ? '1' : '2'
    const mainProb = Math.max(hPct, aPct)
    // Full quant (markets + probs incl. first-half) so the UI has data for every match
    const offlineMarkets = this._buildOfflineMarkets(probs, m)
    const offlineQuant = {
      main_pick: mainPick,
      secondary_pick: 'O/U U2.5',
      ev_score: '0.00',
      risk_label: mainProb > 45 ? 'SAFE' : mainProb > 38 ? 'STABLE' : 'RISKY BET',
      market_strength: 'NORMAL',
      markets: offlineMarkets,
      probs: {
        btts: probs ? Math.round(probs.btts.yes * 100) : 40,
        over25: probs ? Math.round(probs.over25 * 100) : 40,
        ht_goal: probs ? Math.round(probs.ht_goal * 100) : 50,
      },
    }
    return {
      ...m,
      success: true,
      ai_source: 'BASELINE_ENGINE',
      home_win_probability: hPct,
      draw_probability: dPct,
      away_win_probability: aPct,
      expected_score: `${Math.round(xgH)} - ${Math.round(xgA)}`,
      verdict: mainProb > 45 ? 'SAFE' : mainProb > 38 ? 'STABLE' : 'RISKY BET',
      prediction: mainPick,
      power_score: Math.round(mainProb),
      ou_25_prob: probs ? Math.round(probs.over25 * 100) : 40,
      btts_prob: probs ? Math.round(probs.btts.yes * 100) : 40,
      insufficient_data: 1,
      confidence: Math.round(mainProb * 0.6),
      ev_score: 0,
      quant: offlineQuant,
      predictions: [
        { label: 'MAIN', val: mainPick },
        { label: 'EDGE', val: (mainProb - Math.min(hPct, aPct)).toFixed(1) + '%' },
        { label: '2ND', val: hPct >= aPct ? 'X2' : '1X' },
        { label: 'RISK', val: mainProb > 45 ? 'SAFE' : 'RISKY BET' },
      ],
    }
  }

  /**
   * Build the same markets shape as QuantumQuantEngine._generateMarkets from
   * a Poisson probs object, so every match (even low-data) exposes the full
   * market data the UI needs (BTTS OUI/NON, O/U, double chance, first-half).
   */
  _buildOfflineMarkets(probs, m = {}) {
    if (!probs) return {}
    const calcEV = (prob, odds) => prob * (odds || 2.0) - 1
    const p = probs
    return {
      match_result: {
        1: { prob: p.win.home, odds: m.odds_home, ev: calcEV(p.win.home, m.odds_home) },
        X: { prob: p.win.draw, odds: m.odds_draw, ev: calcEV(p.win.draw, m.odds_draw) },
        2: { prob: p.win.away, odds: m.odds_away, ev: calcEV(p.win.away, m.odds_away) },
      },
      over_under: {
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
        'O0.5': { prob: p.first_half.goal_yes, odds: 1.5, ev: calcEV(p.first_half.goal_yes, 1.5) },
        'O1.5': { prob: p.first_half.ou15, odds: 3.5, ev: calcEV(p.first_half.ou15, 3.5) },
        BTTS: { prob: p.first_half.btts, odds: 6.0, ev: calcEV(p.first_half.btts, 6.0) },
      },
    }
  }

  /**
   * Enrichit une liste de matchs
   * - fastMode=true (défaut): JS-only QuantumQuantEngine (<100ms)
   * - fastMode=false: Python FastAPI ML avec contrôle de concurrence
   */
  async enrichMatches(matches, options = {}) {
    const { fastMode = true, force = false } = options

    // Détection des matchs nécessitant enrichissement
    // On enrichit uniquement les matchs sans probabilités ou marqués insufficient_data
    const needsEnrichment = force
      ? matches
      : matches.filter((m) => {
          const isInsufficientData = parseInt(m.insufficient_data) === 1
          return (
            !m.home_win_probability ||
            m.home_win_probability === 0 ||
            !m.expected_score ||
            isInsufficientData
          )
        })

    const alreadyEnriched = matches.filter((m) => !needsEnrichment.includes(m))

    logger.info(
      `⚡ [ENRICH] ${alreadyEnriched.length} déjà enrichis, ${needsEnrichment.length} à traiter (fastMode=${fastMode})`
    )

    if (fastMode) {
      // JS-only instantané (<100ms)
      const fastResults = await Promise.all(
        needsEnrichment.map(async (m) => {
          try {
            return await this.fastEnrichMatch(m, { skipBayesian: options.skipBayesian })
          } catch (err) {
            logger.error(`❌ [ENRICH] Fast path failed for ${m.homeTeam}:`, err.message)
            return m
          }
        })
      )
      return [...alreadyEnriched, ...fastResults]
    }

    // Mode profond: Python FastAPI avec concurrence limitée
    // Pas de pre-check santé — on laisse chaque enrichMatch gérer le fallback
    logger.info(`[ENRICH] Lancement deep enrich avec ML`)

    const CONCURRENCY = parseInt(process.env.ENRICH_CONCURRENCY || '3')
    const BULK_TIMEOUT = parseInt(process.env.ENRICH_TIMEOUT_MS || '45000')
    const results = []
    for (let i = 0; i < needsEnrichment.length; i += CONCURRENCY) {
      const batch = needsEnrichment.slice(i, i + CONCURRENCY)
      const batchResults = await Promise.all(
        batch.map((m) =>
          this.enrichMatch(m, BULK_TIMEOUT).catch((err) => {
            logger.error(`❌ [ENRICH] Deep path failed for ${m.homeTeam}:`, err.message)
            return this.fastEnrichMatch(m)
          })
        )
      )
      results.push(...batchResults)
      if (i + CONCURRENCY < needsEnrichment.length) {
        await new Promise((r) => setTimeout(r, 200))
      }
    }

    return [...alreadyEnriched, ...results]
  }

  /**
   * Version pour dashboard: Ultra rapide, rendu en < 50ms
   */
  async enrichMatchesDashboard(matches) {
    // PAS D'ATTENTE, PAS DE PYTHON, RENDU INSTANTANÉ
    return Promise.all(matches.map((m) => this.fastEnrichMatch(m)))
  }

  /**
   * [NEW] Strategic Reasoning Engine v2.1 (Ultra Precision)
   * Generates a "Who & Why" narrative in Arabic with real player names and headlines
   */
  generateStrategicReasoning(match, newsData) {
    const reasons = []
    const impact = newsData?.impact || {}
    const score = impact.home - impact.away

    // 1. Sentiment & Media Momentum
    if (score >= 8) reasons.push('زخم إعلامي هائل وتغطية إيجابية لصالح صاحب الأرض')
    else if (score <= -8) reasons.push('تغطية إعلامية سلبية جداً وتوتر في معسكر الفريق المضيف')
    else if (score > 3) reasons.push('استقرار فني وأخبار مشجعة ترفع معنويات الفريق المضيف')
    else if (score < -3) reasons.push('أفضلية معنوية واضحة للضيوف بناءً على آخر التقارير')

    // 2. REAL INFO: Specific Absences & Player Names
    const critical = impact.critical || []
    const playerOuts = critical
      .filter((c) => c.includes('OUT'))
      .map((c) => c.replace(' OUT', '').replace(' (Official)', '').replace(' (TM)', ''))

    if (playerOuts.length > 0) {
      const names = playerOuts.slice(0, 2).join(' و ')
      reasons.push(`غيابات هامة تتضمن ${names} مما يقلل الكفاءة التشغيلية`)
    }

    // 3. [V75] Referee & Pitch Intelligence
    if (match.referee_yellow_avg > 0 || match.referee_id) {
      const refProfile = EnvironmentalIntelligence.profileReferee({
        yellow_avg: match.referee_yellow_avg,
        red_avg: match.referee_red_avg,
        penalties_avg: match.referee_penalties_avg,
      })
      reasons.push(refProfile.description_ar)
    }

    if (match.weather_temp || match.weather_desc) {
      const wImpact = EnvironmentalIntelligence.analyzeWeather({
        temp: match.weather_temp,
        desc: match.weather_desc,
      })
      if (wImpact.labels_ar && wImpact.labels_ar.length > 0) {
        reasons.push(wImpact.labels_ar[0])
      }
    }

    if (critical.some((c) => c.includes('LATE FITNESS TEST'))) {
      reasons.push('غموض حول جاهزية بعض النجوم الأساسيين مما يزيد من عامل المخاطرة')
    }

    // 4. Specific Tactical Logic
    if (critical.some((c) => c.includes('GK')))
      reasons.push('هناك قلق بشأن حراسة المرمى قد يستغله الخصم')
    if (critical.some((c) => c.includes('ST')))
      reasons.push('نقص في الحلول الهجومية لغياب صانع اللعب أو الهداف')

    // 5. Momentum & Fatigue
    if (match.home_attack_impact > 1.1) reasons.push('تحسن ملحوظ في الفاعلية الهجومية مؤخراً')
    if (match.fatigue_h < 0.9 || match.fatigue_a < 0.9)
      reasons.push('عامل الإرهاق البدني قد يلعب دوراً حاسماً في الدقائق الأخيرة')

    // 6. [V85] Market Intelligence (Steam & RLM)
    if (match.market_signals && match.market_signals.length > 0) {
      match.market_signals.forEach((sig) => {
        reasons.push(sig.msg)
      })
    }

    const weatherAnalysis = EnvironmentalIntelligence.analyzeWeather({
      temp: match.weather_temp,
      desc: match.weather_desc,
      humidity: match.weather_humidity,
    })
    if (weatherAnalysis.labels_ar.length > 0) {
      reasons.push(weatherAnalysis.labels_ar[0])
    }

    if (reasons.length === 0) {
      return 'تحليل فني متزن بناءً على معطيات القوة التاريخية والحالية للفريقين.'
    }

    // Return a clean combination of top 3-4 insights
    return reasons.slice(0, 4).join(' + ')
  }

  /**
   * [V52-Titanium] Validates the feature vector shape (115 features required)
   */
  validateVector(vector) {
    if (!Array.isArray(vector)) {
      console.error('❌ [V52-Validation] Vector is not an array!')
      return false
    }
    if (vector.length !== 115) {
      console.warn(
        `⚠️ [V52-Validation] Shape Mismatch! Expected 115, got ${vector.length}. This will cause XGBoost failure.`
      )
      return false
    }
    // Check for NaN or Nulls in the vector
    const invalidIdx = vector.findIndex((v) => v === null || v === undefined || isNaN(v))
    if (invalidIdx !== -1) {
      console.warn(
        `⚠️ [V52-Validation] Type Error! Found invalid value at index ${invalidIdx}: ${vector[invalidIdx]}`
      )
      return false
    }
    return true
  }
}

module.exports = new EnrichedPredictionService()
