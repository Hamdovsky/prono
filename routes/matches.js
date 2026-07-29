const express = require('express')
const router = express.Router()
const logger = require('../core/logger')
const database = require('../core/database')
const { speedCache, invalidateCache } = require('../core/speedCache')
const enrichedPredictions = require('../core/enriched_predictions')
const { sanitizeMatches } = require('../core/matchSanitizer')
const bsdService = require('../services/bsdService')
const liveGoalPredictor = require('../services/LiveGoalPredictor')
const liveMatchService = require('../services/liveMatchService')
const { getSteamForMatch } = require('../services/oddsMovementService')
const ValueBetEngine = require('../src/services/ValueBetEngine')
const IntegrityService = require('../services/integrity_service')
const newsService = require('../src/services/newsService')

// Normalize database.query output (returns { rows } in SQLite mode, or a raw
// array/promise in some configurations) into a plain array of row objects.
async function safeQuery(sql, fallback = []) {
  try {
    const r = await database.query(sql)
    if (r && Array.isArray(r.rows)) return r.rows
    if (Array.isArray(r)) return r
    return fallback
  } catch (e) {
    return fallback
  }
}

router.get('/debug/scraper-status', async (req, res) => {
  try {
    const dbStatus = await safeQuery('SELECT COUNT(*) as total FROM matches', [{ total: 0 }])
    const total = dbStatus?.[0]?.total || 0

    const statusCounts = await safeQuery(
      `SELECT status, COUNT(*) as cnt FROM matches GROUP BY status ORDER BY cnt DESC`
    )
    const sourceCounts = await safeQuery(
      `SELECT source, COUNT(*) as cnt FROM matches GROUP BY source ORDER BY cnt DESC`
    )
    const recentMatch = await safeQuery(
      `SELECT homeTeam, awayTeam, league, status, source, timestamp FROM matches ORDER BY timestamp DESC LIMIT 1`
    )

    const hasFD = !!process.env.FOOTBALLDATA_KEY
    const hasAPiF = !!process.env.APIFOOTBALL_KEY
    const hasBSD = !!process.env.BSD_API_KEY
    const hasRapi = !!process.env.RAPIDAPI_KEY

    res.json({
      totalMatches: total,
      statusBreakdown: statusCounts || [],
      sourceBreakdown: sourceCounts || [],
      lastMatch: recentMatch?.[0] || null,
      apiKeys: {
        FOOTBALLDATA_KEY: hasFD,
        APIFOOTBALL_KEY: hasAPiF,
        BSD_API_KEY: hasBSD,
        RAPIDAPI_KEY: hasRapi,
      },
      nodeEnv: process.env.NODE_ENV,
      platform: process.platform,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// One-off backfill: re-fetch BSD events and correct the per-match kickoff
// timestamps that were previously stored with an identical (sync-time) value.
router.post('/debug/bsd-backfill', async (req, res) => {
  try {
    if (!bsdService.isAvailable()) {
      return res.json({ success: false, reason: 'BSD not available' })
    }
    let updated = 0
    const base = new Date()
    for (let i = 0; i < 14; i++) {
      const d = new Date(base.getTime() + i * 86400000)
      const dateStr = d.toISOString().split('T')[0]
      const events = await bsdService.fetchEvents(dateStr)
      if (!events || !events.length) continue
      for (const ev of events) {
        const id = `bsd_${ev.id || ev.match_id || ''}`
        const ts = bsdService._parseTimestamp(ev)
        if (!ts) continue
        const tsIso = new Date(ts * 1000).toISOString()
        try {
          database.db
            .prepare(
              'UPDATE matches SET startTimestamp = ?, timestamp = ? WHERE id = ? AND source = ?'
            )
            .run(ts, tsIso, id, 'bsd')
          updated++
        } catch (_) {
          /* ignore */
        }
      }
    }
    if (typeof invalidateCache === 'function') invalidateCache('upcoming')
    res.json({ success: true, updated })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * GET /api/live
 * Live matches with goal prediction analysis
 */
router.get('/live', async (req, res) => {
  try {
    const matches = liveMatchService.getActiveMatches()
    const enriched = matches.map((m) => {
      const prediction = liveGoalPredictor.analyzeLiveMatch(m)
      return { ...m, goalPrediction: prediction }
    })
    res.json(enriched)
  } catch (err) {
    logger.error(`[LIVE] Error: ${err.message}`)
    res.json([])
  }
})

/**
 * GET /api/live/goal-predictions
 * Expert live goal predictor endpoint
 */
/**
 * GET /api/live-lab
 * Live Lab dashboard data
 */
router.get('/live-lab', async (req, res) => {
  try {
    const matches = liveMatchService.getActiveMatches()
    const enriched = matches.map((m) => {
      const prediction = liveGoalPredictor.analyzeLiveMatch(m)

      // Log snapshot for training
      if (m.minute && parseInt(m.minute) > 0) {
        database
          .logLivePrediction({
            matchId: m.id,
            homeTeam: m.homeTeam,
            awayTeam: m.awayTeam,
            league: m.league,
            minute: parseInt(m.minute) || 0,
            scoreHome: m.scoreHome ?? 0,
            scoreAway: m.scoreAway ?? 0,
            predNext5: prediction?.next5min ?? 0,
            predNext10: prediction?.next10min ?? 0,
            predNext15: prediction?.next15min ?? 0,
            homeXg: m.home_xg || m.xg?.home || 0,
            awayXg: m.away_xg || m.xg?.away || 0,
            homeSot: m.shots_on_target_home || m.stats?.shotsOnTarget?.home || 0,
            awaySot: m.shots_on_target_away || m.stats?.shotsOnTarget?.away || 0,
            homeCorners: m.corners_home || m.stats?.corners?.home || 0,
            awayCorners: m.corners_away || m.stats?.corners?.away || 0,
            homePossession: m.possession_home || m.stats?.possession?.home || 50,
            alertLevel: prediction?.alertLevel || 'NORMAL',
            source: m.source || 'unknown',
          })
          .catch((e) => logger.warn(`[LIVE] Log prediction failed: ${e.message}`))
      }

      return {
        ...m,
        goalPrediction: prediction,
        stats: m.stats || {
          dangerousAttacks: { home: 0, away: 0 },
          shotsOnTarget: { home: 0, away: 0 },
          xg: { home: 0, away: 0 },
        },
        momentum: m.momentum || { homePercent: 50, awayPercent: 50 },
        alerts:
          prediction?.alertLevel === 'IMMINENT' || prediction?.alertLevel === 'CRITICAL'
            ? [{ level: prediction.alertLevel, message: prediction.alertMessage || 'Goal alert' }]
            : [],
        recoveryRate: 50,
        xgDeviation: { home: 0, away: 0, verdict: 'Normal' },
        dnaInsight: null,
        statsbombInsight: null,
        pronostics: null,
      }
    })
    res.json({
      matches: enriched,
      counts: {
        live: matches.filter((m) => m.status === 'live').length,
        total: matches.length,
      },
      lastUpdate: Date.now(),
    })
  } catch (err) {
    logger.error(`[LIVE-LAB] Error: ${err.message}`)
    res.json({ matches: [], counts: { live: 0, total: 0 }, lastUpdate: Date.now() })
  }
})

router.get('/live/goal-predictions', async (req, res) => {
  try {
    const matches = liveMatchService.getActiveMatches()
    const predictions = matches.map((m) => ({
      matchId: m.id,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      minute: m.minute,
      score: `${m.scoreHome}-${m.scoreAway}`,
      prediction: liveGoalPredictor.analyzeLiveMatch(m),
    }))
    res.json(predictions)
  } catch (err) {
    logger.error(`[LIVE] Goal prediction error: ${err.message}`)
    res.json([])
  }
})

router.get('/upcoming', speedCache('upcoming', 15000, 600000), async (req, res) => {
  try {
    // [PREMATCH ONLY] strictly filter out live/in-progress matches
    const allMatches = await database.getMatchesByStatuses([
      'scheduled',
      'upcoming',
      'NOT_STARTED',
      'NS',
    ])
    let rawMatches = allMatches

    const daysParam = parseInt(req.query.days) || 3
    const maxDays = Math.min(Math.max(daysParam, 1), 14)
    const startOfToday = new Date().setHours(0, 0, 0, 0)
    const endOfRange = startOfToday + maxDays * 24 * 60 * 60 * 1000

    rawMatches = rawMatches.filter((m) => {
      let rawTs = m.startTimestamp

      if (!rawTs || rawTs === 0) {
        try {
          const data = typeof m.fullData === 'string' ? JSON.parse(m.fullData) : m.fullData
          if (data && data.startTimestamp) rawTs = data.startTimestamp
        } catch (e) {}
      }

      // If still no timestamp, treat as "today" (match will show)
      if (!rawTs || rawTs === 0) {
        return true
      }

      let tsMs
      if (typeof rawTs === 'string' && rawTs.includes('T')) {
        tsMs = new Date(rawTs).getTime()
      } else {
        tsMs = parseInt(rawTs) > 1e11 ? parseInt(rawTs) : parseInt(rawTs) * 1000
      }

      if (isNaN(tsMs)) return true // can't parse → show anyway

      // Show matches from the start of today up to 72h in future
      return tsMs >= startOfToday && tsMs <= endOfRange
    })

    // If no upcoming matches, fallback to recent matches (last 7 days)
    if (rawMatches.length === 0) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).getTime()
      const allMatches = await database.getMatchesByStatuses([
        'scheduled',
        'upcoming',
        'NOT_STARTED',
        'NS',
      ])
      rawMatches = allMatches.filter((m) => {
        let rawTs = m.startTimestamp
        if (!rawTs || rawTs === 0) {
          try {
            const data = typeof m.fullData === 'string' ? JSON.parse(m.fullData) : m.fullData
            if (data && data.startTimestamp) rawTs = data.startTimestamp
          } catch (e) {}
        }
        if (!rawTs || rawTs === 0) return true // null ts → show
        let tsMs
        if (typeof rawTs === 'string' && rawTs.includes('T')) {
          tsMs = new Date(rawTs).getTime()
        } else {
          tsMs = parseInt(rawTs) > 1e11 ? parseInt(rawTs) : parseInt(rawTs) * 1000
        }
        return !isNaN(tsMs) && tsMs >= sevenDaysAgo
      })
      if (rawMatches.length > 0) {
        logger.info(
          `[UPCOMING] No upcoming matches — showing ${rawMatches.length} recent matches as fallback`
        )
      }
    }

    // 🔁 [STRICT DEDUP] Prioritize most imminent match per team pair
    const teamPairMap = new Map()
    rawMatches.forEach((m) => {
      const home = (m.homeTeam || '').toLowerCase().trim()
      const away = (m.awayTeam || '').toLowerCase().trim()
      // Sort pair alphabetically to catch reversed duplicates (ex: A vs B and B vs A)
      const pair = [home, away].sort()
      const pairKey = `${pair[0]}|${pair[1]}`

      const mTs =
        m.startTimestamp > 1e11
          ? m.startTimestamp
          : m.startTimestamp
            ? m.startTimestamp * 1000
            : Infinity

      if (!teamPairMap.has(pairKey) || mTs < teamPairMap.get(pairKey)._ts) {
        m._ts = mTs
        teamPairMap.set(pairKey, m)
      }
    })
    rawMatches = Array.from(teamPairMap.values())

    // 🚫 [QUALITY GATE v2] Server-side filter — élimine les matchs de mauvaise qualité AVANT enrichissement
    const RESERVE_RE =
      /\b(II|III|IV|B|C|U\d{2}|U-\d{2}|Reserves?|Youth|Academy|Reserve|Filial|Amateurs?|Dev(elopment)?|Juniors?)\b/i
    const isReserve = (name) => name && RESERVE_RE.test(name)

    rawMatches = rawMatches
      .filter((m) => {
        const home = m.homeTeam || ''
        const away = m.awayTeam || ''
        if (isReserve(home) || isReserve(away)) return false
        if (/\s(II|III|2|3)$/i.test(home) || /\s(II|III|2|3)$/i.test(away)) return false
        const oddsH = parseFloat(m.odds_home || 0)
        const oddsA = parseFloat(m.odds_away || 0)
        if ((oddsH > 0 && oddsH < 1.1) || (oddsA > 0 && oddsA < 1.1)) return false
        return true
      })
      .map((m) => {
        m.display_odds_home = m.best_odds_home || m.odds_home
        m.display_odds_draw = m.best_odds_draw || m.odds_draw
        m.display_odds_away = m.best_odds_away || m.odds_away
        return m
      })

    logger.info(`✅ [QUALITY GATE] ${rawMatches.length} quality matches retained.`)

    // ✅ [QUANT INJECTOR] Ensure every match has a quant object from DB fields
    rawMatches = rawMatches.map((m) => {
      if (!m.quant) m.quant = {}
      if (!m.quant.main_pick && m.prediction) m.quant.main_pick = m.prediction
      if (!m.quant.ev_score) {
        // Map from DB columns ev_home/ev_draw/ev_away -> ev_score
        const evH = parseFloat(m.ev_home || 0)
        const evD = parseFloat(m.ev_draw || 0)
        const evA = parseFloat(m.ev_away || 0)
        const bestEv = Math.max(evH, evD, evA)
        if (bestEv > 0) {
          m.quant.ev_score = (bestEv / 100).toFixed(2)
        } else if (m.ev_score != null) {
          m.quant.ev_score = m.ev_score
        } else {
          m.quant.ev_score = '0.00'
        }
      }
      if (!m.quant.expected_score && m.expected_score) m.quant.expected_score = m.expected_score
      if (!m.quant.risk_label) {
        const hWP = parseFloat(m.home_win_probability || 0)
        const aWP = parseFloat(m.away_win_probability || 0)
        const maxP = Math.max(hWP, aWP)
        if (maxP >= 75) m.quant.risk_label = 'SAFE'
        else if (maxP >= 60) m.quant.risk_label = 'STABLE'
        else m.quant.risk_label = 'BALANCED'
      }
      return m
    })

    // 🧹 [DATA SANITIZER] Remove zombie/frozen/corrupted matches before enrichment
    const { sanitized, stats: sanitStats } = sanitizeMatches(rawMatches)
    rawMatches = sanitized
    if (sanitStats.rejected > 0) {
      logger.info(
        `🧹 [SANITIZER] ${sanitStats.rejected} zombie/corrupted matches removed. Reasons:`,
        sanitStats.reasons
      )
    }

    // 🚀 JIT enrichment removed — use /api/re-enrich to trigger enrichment separately.
    // Speed and stability are preferred over inline enrichment on the free tier.

    // 🧠 [NEURAL-X FILTER] Split elite matches from fallback pool
    const elite = []
    const fallback_pool = []
    for (const m of rawMatches) {
      const q = m.quant || {}
      const ev = parseFloat(q.ev_score)
      const rl = q.risk_label || ''
      const hWP = parseFloat(m.home_win_probability || 0)
      const dWP = parseFloat(m.draw_probability || 0)
      const aWP = parseFloat(m.away_win_probability || 0)
      const probs = [hWP, dWP, aWP].sort((a, b) => b - a)
      const margin = probs[0] - probs[1]
      const isEvDead = ev > 0 && Math.abs(ev - 0.32) < 0.001
      const isLowEv = ev > 0 && ev < 0.2
      const isFlat = margin < 5
      const isStableLow = rl === 'STABLE' && (isLowEv || isFlat || Math.abs(ev) < 0.001)
      if (isStableLow || isEvDead || isLowEv || isFlat) {
        fallback_pool.push(m)
      } else {
        elite.push(m)
      }
    }
    // Sort elite by EV descending
    elite.sort((a, b) => {
      const evA = parseFloat((a.quant || {}).ev_score || 0)
      const evB = parseFloat((b.quant || {}).ev_score || 0)
      return evB - evA
    })

    // 👑 [PAYWALL] Mark VIP content — SOLID picks ≥75% prob + VALUE BET draws
    const vip = []
    const free = []
    for (const m of elite) {
      const q = m.quant || {}
      const pick = (q.main_pick || '').toString().trim().toUpperCase()
      const hWP = parseFloat(m.home_win_probability || 0)
      const aWP = parseFloat(m.away_win_probability || 0)
      const dvb = m.draw_value_bet === true || m.draw_value_bet === 'True' || m.draw_value_bet === 1
      const isSolidPick = (pick === '1' && hWP >= 75) || (pick === '2' && aWP >= 75)
      const isVip = isSolidPick || dvb
      m._vip = isVip
      if (isVip) vip.push(m)
      else free.push(m)
    }

    const tier = (req.query.tier || '').toLowerCase()
    const responseElite = tier === 'free' ? free : elite

    logger.info(
      `📊 [UPCOMING] ${responseElite.length} elite + ${fallback_pool.length} fallback (${vip.length} VIP locked)`
    )
    res.json({
      elite: responseElite,
      vip_locked: tier === 'free' ? vip : [],
      fallback_pool,
      counts: { elite: responseElite.length, fallback: fallback_pool.length, vip: vip.length },
    })

    // 💡 [OPTIMIZATION] Background enrichment trigger removed.
    // Enrichment is now handled strictly by the Scraper and Cron jobs to prevent API-driven OOM.
  } catch (err) {
    logger.error(`💥 [API ERROR] GET /api/upcoming failed: ${err.message}`, { stack: err.stack })
    res.status(500).json({ error: err.message || 'Internal Server Error' })
  }
})

/**
 * GET /api/predictions
 * High-confidence predictions (>=75% confidence) from pre-enriched DB records.
 * Uses ONLY the sync query layer — zero JIT network calls.
 */
router.get('/predictions', async (req, res) => {
  try {
    const db = require('../core/database')
    const matches = await db.getMatchesByStatuses(['scheduled', 'upcoming', 'NOT_STARTED', 'NS'])
    const minConf = parseFloat(req.query.min_confidence) || 75

    const quality = matches
      .filter((m) => {
        const hWP = parseFloat(m.home_win_probability || 0)
        const dWP = parseFloat(m.draw_probability || 0)
        const aWP = parseFloat(m.away_win_probability || 0)
        const pick = (m.prediction || '').toString().trim().toUpperCase()
        if (pick === '1' && hWP >= minConf) return true
        if (pick === '2' && aWP >= minConf) return true
        return false
      })
      .map((m) => ({
        id: m.id,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        league: m.league,
        startTimestamp: m.startTimestamp,
        prediction: m.prediction,
        home_win_probability: parseFloat(m.home_win_probability || 0),
        draw_probability: parseFloat(m.draw_probability || 0),
        away_win_probability: parseFloat(m.away_win_probability || 0),
        expected_score: m.expected_score || 'N/A',
        ev_score: parseFloat(m.ev_score || 0),
        ou_25_prob: parseFloat(m.ou_25_prob || 0),
        btts_prob: parseFloat(m.btts_prob || 0),
        odds_home: parseFloat(m.odds_home || 0),
        odds_draw: parseFloat(m.odds_draw || 0),
        odds_away: parseFloat(m.odds_away || 0),
      }))

    quality.sort(
      (a, b) =>
        b.home_win_probability +
        b.away_win_probability -
        (a.home_win_probability + a.away_win_probability)
    )

    res.json({
      success: true,
      count: quality.length,
      threshold: minConf,
      predictions: quality,
    })
  } catch (e) {
    logger.error(`[PREDICTIONS] Error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * POST /api/refresh-upcoming
 */
router.post('/refresh-upcoming', async (req, res) => {
  try {
    if (typeof invalidateCache === 'function') {
      invalidateCache('upcoming')
    }
    res.json({ success: true, message: 'Cache cleared.' })
  } catch (error) {
    res.status(500).json({ error: 'Refresh failed' })
  }
})

/**
 * GET /api/odds/steam/:matchId
 */
router.get('/odds/steam/:matchId', async (req, res) => {
  try {
    const result = getSteamForMatch(req.params.matchId)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * GET /api/market/edge - Filter for upcoming only
 */
router.get('/market/edge', async (req, res) => {
  try {
    const allMatches = await database.getMatchesByStatuses([
      'scheduled',
      'upcoming',
      'NOT_STARTED',
      'NS',
    ])
    const matches = allMatches.filter((m) => m.source === 'africanobet')
    const results = []
    for (const m of matches) {
      if (!m.home_win_probability || !m.odds_home) continue
      const analysis = ValueBetEngine.analyzeValue({
        modelHome: m.home_win_probability * 100,
        modelDraw: m.draw_probability * 100,
        modelAway: m.away_win_probability * 100,
        homeOdds: m.odds_home,
        drawOdds: m.odds_draw,
        awayOdds: m.odds_away,
      })
      if (analysis && analysis.hasValue) {
        const newsIntel = m.news_data || { headlines: [] }
        const integrity = await IntegrityService.analyzeMatch(m, m, newsIntel)
        results.push({
          id: m.id,
          match: `${m.homeTeam} vs ${m.awayTeam}`,
          league: m.league,
          time: m.time || m.timestamp,
          analysis: analysis.best,
          integrity: {
            score: integrity.score,
            status: integrity.trafficLight,
            recommendation: integrity.recommendation,
            tags: integrity.strategicTags,
          },
          sharp_score: m.sharp_score || 0,
          kelly: analysis.best.kelly,
        })
      }
    }
    results.sort((a, b) => b.analysis.edge - a.analysis.edge)
    res.json(results)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * POST /api/refresh-lineups/:id
 */
router.post('/refresh-lineups/:id', async (req, res) => {
  const { id } = req.params
  try {
    const match = await database.getMatchById(id)
    if (!match) return res.status(404).json({ error: 'Not found' })
    const intel = await newsService.getMatchIntelligence(
      match.id_sofa,
      match.homeTeam,
      match.awayTeam,
      match.startTimestamp,
      { forceRefresh: true }
    )
    if (intel && intel.confirmed) {
      const updated = await enrichedPredictions.enrichMatch(match)
      res.json({ success: true, confirmed: true, match: updated })
    } else {
      res.json({ success: true, confirmed: false })
    }
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Force re-enrichment of upcoming matches with current API data (BSD, etc.)
router.post('/re-enrich', async (req, res) => {
  try {
    const key = req.headers['x-api-key']
    if (!key || key !== process.env.API_SECRET_KEY) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    const db = require('../core/database')
    const matches = await db.getMatchesByStatuses(['scheduled', 'upcoming', 'NOT_STARTED', 'NS'])
    if (!matches || matches.length === 0) {
      return res.json({ success: true, enriched: 0, message: 'No matches to enrich' })
    }
    const logger = require('../core/logger')
    const limit = Math.min(parseInt(req.query.limit) || 3, 50)
    const batch = matches.slice(0, limit)
    let enriched = 0
    for (const m of batch) {
      try {
        const result = await enrichedPredictions.fastEnrichMatch(m)
        if (result && result.success) {
          await db.query(
            `UPDATE matches SET
              home_win_probability = $1, draw_probability = $2, away_win_probability = $3,
              ou_25_prob = $4, btts_prob = $5, expected_score = $6,
              prediction = $7, confidence = $8, edge_score = $9, ev_score = $10,
              insufficient_data = $11, ai_source = $12,
              home_xg = $13, away_xg = $14,
              quant = $15
            WHERE id = $16`,
            [
              result.home_win_probability, result.draw_probability, result.away_win_probability,
              result.ou_25_prob, result.btts_prob, result.expected_score,
              result.prediction, result.confidence, result.edge_score, result.ev_score,
              result.insufficient_data ? 1 : 0, result.ai_source || 'jit',
              result.home_xg || result.xg_home, result.away_xg || result.xg_away,
              JSON.stringify(result.quant || {}), m.id
            ]
          )
          enriched++
        }
      } catch (e) {
        logger.warn(`[RE-ENRICH] Skip ${m.id}: ${e.message}`)
      }
    }
    invalidateCache('upcoming')
    logger.info(`[RE-ENRICH] Updated ${enriched}/${limit} matches`)
    res.json({ success: true, total: matches.length, enriched, message: `Enriched ${enriched}/${limit} matches` })
  } catch (e) {
    logger.error(`[RE-ENRICH] Error: ${e.message}`)
  }
})

// Cache invalidation endpoint (called by worker after enrich)
router.post('/invalidate-cache', (req, res) => {
  const key = req.headers['x-api-key']
  if (!key || key !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const prefixes = req.body?.prefixes || ['upcoming', 'live', 'combos']
  for (const p of prefixes) {
    invalidateCache(p)
  }
  res.json({ invalidated: prefixes })
})

module.exports = router
