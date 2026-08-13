const express = require('express')
const router = express.Router()
const database = require('../core/database')
const shieldEngine = require('../core/shieldEngine')
const mlPredictionService = require('../services/mlPredictionService')
const configEngine = require('../core/configEngine')
const securityEngine = require('../core/securityEngine')
const { speedCache } = require('../core/speedCache')
const logger = require('../core/logger')

/**
 * GET /api/health/full — Complete system health dashboard
 */
router.get('/health/full', async (req, res) => {
  try {
    const { getFullHealth } = require('../services/healthDashboard')
    const health = await getFullHealth()
    res.json(health)
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message })
  }
})

/**
 * GET /api/ping - Diagnostic ping
 */
const botService = require('../services/botService')

router.get('/ping', (req, res) => res.send('API_PONG'))

/**
 * GET /api/bot-debug - Debug bot env variables in production safely
 */
const localOrAuth = (req, res, next) => {
  const ip = req.socket?.remoteAddress || ''
  const isLocalhost = ip.includes('127.0.0.1') || ip.includes('::1') || ip === '::ffff:127.0.0.1'
  if (isLocalhost || process.env.NODE_ENV !== 'production') return next()
  return securityEngine.authenticate(req, res, next)
}

router.get('/bot-debug', localOrAuth, (req, res) => {
  res.json({
    hasToken: !!botService.token,
    tokenLength: botService.token ? botService.token.length : 0,
    tokenStart: botService.token ? botService.token.substring(0, 5) : 'none',
    hasChatId: !!botService.chatId,
    chatIdLength: botService.chatId ? botService.chatId.length : 0,
    chatIdStart: botService.chatId ? botService.chatId.substring(0, 5) : 'none',
    isPolling: botService.isPolling || false,
  })
})

/**
 * GET /api/db-debug - Safely check SQLite contents in production
 */
router.get('/db-debug', localOrAuth, (req, res) => {
  try {
    const countRow = database.prepare('SELECT COUNT(*) as count FROM matches').get()
    const statusRows = database
      .prepare('SELECT status, COUNT(*) as count FROM matches GROUP BY status')
      .all()
    const sourceRows = database
      .prepare('SELECT source, COUNT(*) as count FROM matches GROUP BY source')
      .all()

    const sampleRows = database
      .prepare(
        'SELECT id, homeTeam, awayTeam, status, timestamp, startTimestamp, source FROM matches ORDER BY last_updated DESC LIMIT 5'
      )
      .all()

    res.json({
      total: countRow ? countRow.count : 0,
      statuses: statusRows || [],
      sources: sourceRows || [],
      samples: sampleRows || [],
      serverTime: new Date().toISOString(),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * GET /api/system/intel - High-precision telemetry for Command Center
 */
router.get('/system/intel', async (req, res) => {
  try {
    const stats = shieldEngine.getStatus()
    const mlStatus = mlPredictionService.getStatus()
    const strategyParams = configEngine.getStrategyParams()

    const totalMatchesRow = database.prepare('SELECT COUNT(*) as count FROM matches').get()
    const lastSyncRow = database.prepare('SELECT MAX(last_updated) as lastSync FROM matches').get()
    const bySource = database
      .prepare(
        'SELECT source, COUNT(*) as count FROM matches WHERE source IS NOT NULL GROUP BY source'
      )
      .all()
    const liveCount = database
      .prepare("SELECT COUNT(*) as count FROM matches WHERE status = 'live'")
      .get()

    const apiServices = {}
    const apiChecks = [
      {
        name: 'BSD',
        key: process.env.BSD_API_KEY,
        check: process.env.BSD_API_KEY && !process.env.BSD_API_KEY.includes('CHANGER'),
      },
      {
        name: 'PredixSport',
        key: process.env.PREDIXSPORT_API_KEY,
        check: !!process.env.PREDIXSPORT_API_KEY,
      },
      {
        name: 'FootballData',
        key: process.env.FOOTBALLDATA_KEY,
        check: process.env.FOOTBALLDATA_ENABLED === 'true',
      },
      {
        name: 'DeepSeek/Groq',
        key: process.env.DEEPSEEK_API_KEY || process.env.GROQ_API_KEY,
        check: !!(process.env.DEEPSEEK_API_KEY || process.env.GROQ_API_KEY),
      },
      {
        name: 'RapidAPI',
        key: process.env.RAPIDAPI_KEY,
        check: !!process.env.RAPIDAPI_KEY && process.env.RAPIDAPI_ENABLED === 'true',
      },
      { name: 'SofaScore', key: null, check: true },
      { name: 'Promosport', key: null, check: true },
    ]
    for (const svc of apiChecks) {
      apiServices[svc.name] = {
        configured: svc.check,
        keyPresent: !!svc.key,
      }
    }

    res.json({
      telemetry: {
        latency: stats.latency || 0,
        shieldActive: stats.shieldActive || false,
        activeProxy: stats.activeProxy || 'DIRECT',
        level: stats.shieldActive ? 1 : 0,
      },
      ai_workers: {
        queue: mlStatus.queueSize || 0,
        busy: mlStatus.isPredicting || false,
        cacheHits: mlStatus.cacheCount || 0,
      },
      strategy: {
        active: configEngine.get('strategy') || 'default',
        label: strategyParams.label || 'Standard',
        oddsCap: strategyParams.oddsCap || 0,
      },
      database: {
        totalMatches: totalMatchesRow?.count || 0,
        lastSync: lastSyncRow?.lastSync || 0,
        liveCount: liveCount?.count || 0,
        sources: bySource,
      },
      apiServices,
      uptime: process.uptime(),
      memory: process.memoryUsage().heapUsed,
    })
  } catch (error) {
    logger.error('[API] /system/intel failure', error)
    res.status(500).json({ status: 'error', error: error.message })
  }
})

/**
 * GET /api/system/status
 */
router.get('/status', async (req, res) => {
  try {
    const totalMatchesRow = database.prepare('SELECT COUNT(*) as count FROM matches').get()
    const liveMatchesRow = database
      .prepare("SELECT COUNT(*) as count FROM matches WHERE status = 'live'")
      .get()
    const lastSyncRow = database.prepare('SELECT MAX(last_updated) as lastSync FROM matches').get()

    res.json({
      status: 'ONLINE',
      lastSync: lastSyncRow?.lastSync || 0,
      totalMatches: totalMatchesRow?.count || 0,
      liveMatchesCount: liveMatchesRow?.count || 0,
      uptime: process.uptime(),
      memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
    })
  } catch (error) {
    logger.error('[API] /status failure', error)
    res.status(500).json({ status: 'error', error: error.message })
  }
})

/**
 * GET /api/rapidapi/status - Live RapidAPI Quota Status
 */
router.get('/rapidapi/status', (req, res) => {
  try {
    const rapidApiQuotaManager = require('../services/rapidApiQuotaManager')
    const { createQuotaManager } = require('../services/sourceQuotaManager')
    const fdQuotaManager = createQuotaManager('footballdata')
    res.json({
      success: true,
      rapidapi: rapidApiQuotaManager.getQuotaStatus(),
      footballdata: {
        enabled: process.env.FOOTBALLDATA_ENABLED === 'true',
        host: process.env.FOOTBALLDATA_HOST || 'footballdata.io',
        quota: fdQuotaManager.getQuotaStatus(),
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

router.get('/health', async (req, res) => {
  try {
    const memUsage = process.memoryUsage()

    // Health check response
    const health = {
      status: 'ONLINE',
      uptime: Math.floor(process.uptime()),
      memory: {
        heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
        rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
        external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
      },
      node: process.version,
      env: process.env.NODE_ENV || 'development',
      timestamp: Date.now(),
    }

    // Add model_manager stats if available (Python via child process or ENV flag)
    try {
      // Default to true for production RAM optimization
      const useModelManager = process.env.USE_MODEL_MANAGER !== 'false'
      if (useModelManager) {
        health.model_manager = {
          enabled: true,
          mode: 'optimized',
        }
      } else {
        health.model_manager = {
          enabled: false,
          mode: 'legacy',
        }
      }
    } catch (e) {
      // Model manager not available - OK
    }

    // Database check (optional)
    try {
      const totalMatchesRow = database.prepare('SELECT COUNT(*) as count FROM matches').get()
      health.database = {
        connected: true,
        matches: totalMatchesRow?.count || 0,
      }
    } catch (dbErr) {
      health.database = {
        connected: false,
        error: dbErr.message,
      }
    }

    res.json(health)
  } catch (fatalErr) {
    logger.error('CRITICAL ERROR in /api/health route', fatalErr)
    res.status(500).json({ status: 'error', message: fatalErr.message })
  }
})

/**
 * POST /api/predict - High-speed prediction gateway
 * 🛡️ Localhost (scraper process) is always trusted — no token required for 127.0.0.1 / ::1
 */
const localOnlyOrAuth = (req, res, next) => {
  const ip = req.socket?.remoteAddress || ''
  const isLocalhost = ip.includes('127.0.0.1') || ip.includes('::1') || ip === '::ffff:127.0.0.1'
  if (isLocalhost) return next() // Internal scraper — trusted
  return securityEngine.authenticate(req, res, next) // External — require token
}

router.post('/predict', localOnlyOrAuth, async (req, res) => {
  try {
    const result = await mlPredictionService.getMLPrediction(req.body)
    res.json({ success: true, ...result })
  } catch (err) {
    logger.error(`[AI Gateway] Prediction Error: ${err.message}`)
    res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * POST /api/sentiment - High-speed sentiment gateway
 * 🛡️ Localhost is always trusted (same as /predict)
 */
router.post('/sentiment', localOnlyOrAuth, async (req, res) => {
  try {
    const pythonService = require('../core/pythonService')
    const result = await pythonService.predict({ ...req.body, task: 'SENTIMENT' })
    res.json({ success: true, ...result })
  } catch (err) {
    logger.error(`[AI Gateway] Sentiment Error: ${err.message}`)
    res.status(500).json({ success: false, error: err.message })
  }
})

router.post('/system/clear-cache', localOnlyOrAuth, async (req, res) => {
  try {
    const { invalidateCache } = require('../core/speedCache')
    invalidateCache('upcoming')
    res.json({ success: true, message: 'Cache invalidated' })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * GET /api/db-stats — Diagnose DB state from Render logs
 */
router.get('/db-stats', async (req, res) => {
  try {
    const db = database.db
    const total = await db.prepare('SELECT COUNT(*) as cnt FROM matches').get()
    const byStatus = await db
      .prepare('SELECT status, COUNT(*) as cnt FROM matches GROUP BY status')
      .all()
    const today = new Date().toISOString().split('T')[0]
    const todayStart = Math.floor(new Date(today + 'T00:00:00Z').getTime() / 1000)
    const todayEnd = todayStart + 86400
    const todayCount = await db
      .prepare(
        'SELECT COUNT(*) as cnt FROM matches WHERE startTimestamp >= ? AND startTimestamp < ?'
      )
      .get(todayStart, todayEnd)
    const sample = await db
      .prepare(
        'SELECT id, homeTeam, awayTeam, league, status, startTimestamp FROM matches ORDER BY startTimestamp DESC LIMIT 5'
      )
      .all()
    res.json({
      total: total?.cnt || 0,
      today: todayCount?.cnt || 0,
      todayRange: {
        from: new Date(todayStart * 1000).toISOString(),
        to: new Date(todayEnd * 1000).toISOString(),
      },
      byStatus,
      sample,
      serverTime: new Date().toISOString(),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * GET /api/scraper/sources — Resilient scraper health + metrics + scan history
 */
router.get('/scraper/sources', async (req, res) => {
  try {
    const fs = require('fs')
    const path = require('path')
    const dataDir = path.join(__dirname, '..', 'data')
    const statePath = path.join(dataDir, 'scraper_state.json')
    const historyPath = path.join(dataDir, 'scraper_history.json')

    const readJson = (p) => {
      if (!fs.existsSync(p)) return null
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'))
      } catch (_) {
        return null
      }
    }

    const state = readJson(statePath)
    const historyRaw = readJson(historyPath)
    const history = Array.isArray(historyRaw) ? historyRaw : []
    const { computeSourceMetrics, detectSilentFailure } = require('../services/sourceMetrics')

    const metrics = computeSourceMetrics(history)
    const health = state?.sources || {}

    const sources = {}
    for (const name of new Set([...Object.keys(health), ...Object.keys(metrics)])) {
      sources[name] = { ...(health[name] || {}), ...(metrics[name] || {}) }
    }

    res.json({
      success: true,
      sources,
      history: history.slice(-20).map((s) => ({
        at: s.finishedAt || s.startedAt,
        dates: s.dates,
        coverage: s.coverage,
        sources: s.sources,
      })),
      silentFailure: detectSilentFailure(history, 'livescore'),
      lastScan: state
        ? {
            at: state.lastScanAt,
            dates: state.dates,
            coverage: state.coverage,
            silentFailure: state.silentFailure,
          }
        : null,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Simple in-memory lock so only one resilient scan runs at a time.
let scraperRunInFlight = false

/**
 * POST /api/scraper/run — Manually trigger the resilient scan
 * (results J-3..J-1, then fixtures J..J+2, then settlement).
 * Secured like other admin endpoints: localhost bypass, otherwise Bearer token.
 */
router.post('/scraper/run', localOrAuth, async (req, res) => {
  try {
    if (scraperRunInFlight) {
      return res.status(409).json({ success: false, error: 'Un scan est déjà en cours' })
    }
    scraperRunInFlight = true
    const { runResilientScan } = require('../services/scraperBridge')
    const result = await runResilientScan()
    res.json({ success: !!result.success, result })
  } catch (e) {
    logger.error(`[SCRAPER] Manual run failed: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  } finally {
    scraperRunInFlight = false
  }
})

/**
 * POST /api/seed — Manually trigger cloud seed (for Render deployments)
 */
router.post('/seed', securityEngine.authenticate.bind(securityEngine), async (req, res) => {
  try {
    const { runCloudSeed } = require('../core/cloudSeed')
    res.json({
      success: true,
      message: 'Seed started in background. Check /api/db-stats in ~2 min.',
    })
    setImmediate(() => {
      runCloudSeed().catch((e) => console.error('[SEED] Error:', e.message))
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * GET /api/league-params — Get calibrated league/team parameters from Neon archive
 */
router.get('/league-params', async (req, res) => {
  try {
    const db = database.db
    const league = req.query.league || ''
    const team = req.query.team || ''

    let sql = 'SELECT * FROM league_model_parameters'
    const conditions = []
    const params = []

    if (league) {
      conditions.push('tournament_name ILIKE $' + (params.length + 1))
      params.push(`%${league}%`)
    }
    if (team) {
      conditions.push('team_name ILIKE $' + (params.length + 1))
      params.push(`%${team}%`)
    }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')
    sql += ' ORDER BY num_matches DESC LIMIT 200'

    const result = await db.prepare(sql).all(...params)
    res.json({ success: true, count: result.length, data: result })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * POST /api/calibrate — Trigger league parameter calibration from Neon archive
 */
router.post('/calibrate', securityEngine.authenticate.bind(securityEngine), async (req, res) => {
  try {
    const { calibrate } = require('../services/leagueCalibrator')
    res.json({ success: true, message: 'Calibration started in background (~30s)' })
    setImmediate(async () => {
      try {
        const result = await calibrate()
        console.log(`[CALIBRATE] Done: ${result.leagues} leagues, ${result.params} params`)
      } catch (e) {
        console.error('[CALIBRATE] Error:', e.message)
      }
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * POST /api/seed/purge — Remove fake/empty matches (homeTeam null, FIFA placeholders)
 */
router.post('/seed/purge', securityEngine.authenticate.bind(securityEngine), async (req, res) => {
  try {
    const { purgeFakeMatches } = require('../core/cloudSeed')
    const removed = await purgeFakeMatches()
    res.json({ success: true, removed })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/**
 * GET /api/test-seed — Diagnostic test to make a direct Sofascore API call
 */
router.get('/test-seed', localOrAuth, async (req, res) => {
  try {
    const axios = require('axios')
    const today = new Date().toISOString().split('T')[0]
    const url = `https://www.sofascore.com/api/v1/sport/football/scheduled-events/${today}`
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://www.sofascore.com',
      Referer: 'https://www.sofascore.com/',
      'x-requested-with': 'XMLHttpRequest',
    }
    const response = await axios.get(url, { headers, timeout: 10000 })
    res.json({
      success: true,
      status: response.status,
      eventsCount: response.data?.events?.length || 0,
      sampleEvent: response.data?.events?.[0]
        ? {
            id: response.data.events[0].id,
            home: response.data.events[0].homeTeam?.name,
            away: response.data.events[0].awayTeam?.name,
          }
        : null,
    })
  } catch (e) {
    res.json({
      success: false,
      message: e.message,
      responseStatus: e.response?.status,
      responseData: e.response?.data ? String(e.response.data).substring(0, 500) : null,
    })
  }
})

/**
 * POST /api/sync-matches
 * Secure cloud synchronization webhook to receive matches pushed from local environments.
 */
router.post(
  '/sync-matches',
  express.json({ limit: '50mb' }),
  securityEngine.authenticate.bind(securityEngine),
  async (req, res) => {
  try {
    const { matches } = req.body
    if (!Array.isArray(matches)) {
      return res.status(400).json({ error: "Invalid payload: 'matches' array is required." })
    }

    const db = database.db
    // Skip PG mode — INSERT OR REPLACE is SQLite-only
    if (!db || !db.pragma) {
      return res.status(400).json({ error: 'PG mode: use Supabase API directly' })
    }
    const insertStmt = db.prepare(`
            INSERT OR REPLACE INTO matches (
                id, "homeTeam", "awayTeam", league, "scoreHome", "scoreAway", minute, status,
                prediction, confidence, "fullData", timestamp, "startTimestamp",
                possession_home, possession_away, dangerous_attacks_home, dangerous_attacks_away,
                shots_on_target_home, shots_on_target_away, corners_home, corners_away,
                source, last_updated, home_win_probability, draw_probability, away_win_probability,
                insufficient_data, odds_home, odds_draw, odds_away
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?
            )
        `)

    // Perform transaction for maximum speed
    const transaction = db.transaction((list) => {
      let count = 0
      for (const m of list) {
        if (!m.id) continue
        insertStmt.run(
          String(m.id),
          m.homeTeam || m.home || 'Home',
          m.awayTeam || m.away || 'Away',
          m.league || 'Unknown',
          parseInt(m.scoreHome || m.goalsHome || 0),
          parseInt(m.scoreAway || m.goalsAway || 0),
          String(m.minute || ''),
          String(m.status || 'scheduled'),
          m.prediction || null,
          parseFloat(m.confidence || 50),
          m.fullData
            ? typeof m.fullData === 'string'
              ? m.fullData
              : JSON.stringify(m.fullData)
            : JSON.stringify(m),
          m.timestamp || new Date().toISOString(),
          parseInt(m.startTimestamp || Math.floor(Date.now() / 1000)),
          parseInt(m.possession_home || 0),
          parseInt(m.possession_away || 0),
          parseInt(m.dangerous_attacks_home || 0),
          parseInt(m.dangerous_attacks_away || 0),
          parseInt(m.shots_on_target_home || 0),
          parseInt(m.shots_on_target_away || 0),
          parseInt(m.corners_home || 0),
          parseInt(m.corners_away || 0),
          m.source || 'sofascore',
          parseInt(m.last_updated || Date.now()),
          parseFloat(m.home_win_probability || 0),
          parseFloat(m.draw_probability || 0),
          parseFloat(m.away_win_probability || 0),
          parseInt(m.insufficient_data || 0),
          parseFloat(m.odds_home || 0),
          parseFloat(m.odds_draw || 0),
          parseFloat(m.odds_away || 0)
        )
        count++
      }
      return count
    })

    const inserted = transaction(matches)
    logger.info(`⚡ [SYNC API] Successfully synchronized ${inserted} matches from local client.`)
    res.json({ success: true, count: inserted })
  } catch (e) {
    logger.error(`❌ [SYNC API] Transaction failed: ${e.message}`)
    res.status(500).json({ error: e.message })
  }
  }
)

/**
 * GET /api/backtest — Validate prediction accuracy on historical fixtures
 */
router.get('/backtest', async (req, res) => {
  try {
    const { runBacktest } = require('../services/backtestEngine')
    const options = {
      limit: parseInt(req.query.limit) || 500,
      league: req.query.league || '',
    }
    const result = await runBacktest(options)
    res.json(result)
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * POST /api/value-scan — Scan upcoming matches for positive EV opportunities
 */
router.post('/value-scan', async (req, res) => {
  try {
    const { scanAll } = require('../services/valueScanner')
    const { matches, predictions } = req.body
    if (!matches || !predictions) {
      return res.status(400).json({ success: false, error: 'Requires matches[] and predictions{}' })
    }
    const opportunities = scanAll(matches, predictions)
    res.json({ success: true, count: opportunities.length, opportunities })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * GET /api/db-stats/extended — Detailed Neon archive statistics
 */
router.get('/db-stats/extended', async (req, res) => {
  try {
    const { query } = require('../core/pg_connector')
    const tables = [
      'soccer_fixtures',
      'soccer_match_stats',
      'soccer_odds',
      'soccer_teams',
      'soccer_leagues',
      'archive_football_data',
      'archive_matches',
      'international_results',
      'league_model_parameters',
    ]
    const stats = {}
    for (const t of tables) {
      const r = await query(`SELECT COUNT(*) as cnt FROM ${t}`)
      stats[t] = r && r.rows ? parseInt(r.rows[0].cnt) : 0
    }
    res.json({ success: true, stats })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * GET /api/staking/stats — Current bankroll & staking stats
 */
router.get('/staking/stats', (req, res) => {
  try {
    const { globalOptimizer } = require('../services/stakingOptimizer')
    res.json({ success: true, stats: globalOptimizer.getStats() })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * POST /api/staking/record — Record a bet result
 */
router.post('/staking/record', (req, res) => {
  try {
    const { globalOptimizer } = require('../services/stakingOptimizer')
    const { match, prediction, stake, won, profit } = req.body
    const stats = globalOptimizer.recordBet(match, prediction, stake, won, profit)
    res.json({ success: true, stats })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * GET /api/confluence/report — Confluence guard accuracy report
 */
router.get('/confluence/report', async (req, res) => {
  try {
    const guard = require('../core/confluenceGuardV2')
    await guard.load()
    res.json({ success: true, report: guard.getReport() })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * POST /api/confluence/record — Record outcome for accuracy tracking
 */
router.post('/confluence/record', async (req, res) => {
  try {
    const guard = require('../core/confluenceGuardV2')
    await guard.load()
    const { match, prediction, actualOutcome } = req.body
    guard.recordOutcome(match, prediction, actualOutcome)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * GET /api/odds-movement/:matchId — Get sharp money signal for a match
 */
router.get('/odds-movement/:matchId', (req, res) => {
  try {
    const analyzer = require('../services/oddsMovementAnalyzer')
    const signal = analyzer.getSignal(req.params.matchId)
    res.json({ success: true, signal })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * POST /api/odds-movement/update — Update odds movement data
 */
router.get('/scraped-odds', async (req, res) => {
  try {
    const scrapedOdds = require('../services/scrapedOddsService')
    const { home, away, league } = req.query
    if (home && away && league) {
      const odds = await scrapedOdds.getLatestOdds(home, away, league)
      return res.json({ success: true, odds })
    }
    const stats = await scrapedOdds.getStats()
    res.json({ success: true, stats })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

router.post(
  '/scraped-odds/store',
  securityEngine.authenticate.bind(securityEngine),
  async (req, res) => {
    try {
      const scrapedOdds = require('../services/scrapedOddsService')
      const { homeTeam, awayTeam, league, oddsHome, oddsDraw, oddsAway, bookmaker } = req.body
      if (!homeTeam || !awayTeam)
        return res.status(400).json({ success: false, error: 'homeTeam, awayTeam required' })
      await scrapedOdds.storeOdds(
        homeTeam,
        awayTeam,
        league,
        oddsHome,
        oddsDraw,
        oddsAway,
        bookmaker
      )
      res.json({ success: true })
    } catch (e) {
      res.status(500).json({ success: false, error: e.message })
    }
  }
)

router.post(
  '/pipeline/value-scan',
  securityEngine.authenticate.bind(securityEngine),
  async (req, res) => {
    try {
      const database = require('../core/database')
      const enrichedPredictions = require('../core/enriched_predictions')
      const { scanAll } = require('../services/valueScanner')
      const { globalOptimizer } = require('../services/stakingOptimizer')

      const matches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS'])
      if (!matches || matches.length === 0)
        return res.json({ success: true, count: 0, message: 'No matches to scan' })

      const limited = matches.slice(0, 100)
      const enriched = await enrichedPredictions.enrichMatches(limited)
      const predictions = {}
      for (const m of enriched) {
        if (m.expected_score && m.expected_score !== 'N/A') {
          predictions[m.id] = m
          await database.updatePredictions(m.id, m)
        }
      }

      const opportunities = await scanAll(limited, predictions)
      const staked = []
      for (const opp of opportunities) {
        const kelly = globalOptimizer.calculateStake(opp.ev, opp.odds)
        if (kelly > 0) {
          staked.push({
            matchId: opp.matchId,
            selection: opp.selection,
            kelly,
            ev: opp.ev,
            odds: opp.odds,
          })
        }
      }

      res.json({
        success: true,
        totalMatches: limited.length,
        enrichedCount: Object.keys(predictions).length,
        opportunitiesCount: opportunities.length,
        stakedCount: staked.length,
        staked: staked.slice(0, 20),
        opportunities: opportunities.slice(0, 30),
      })
    } catch (e) {
      res.status(500).json({ success: false, error: e.message })
    }
  }
)

router.post('/odds-movement/update', (req, res) => {
  try {
    const analyzer = require('../services/oddsMovementAnalyzer')
    const { matchId, oddsHome, oddsDraw, oddsAway } = req.body
    const baseline = analyzer.baselines.get(matchId)
    if (!baseline) {
      // Create baseline first with current odds
      analyzer.baselines.set(matchId, {
        home_open: oddsHome,
        draw_open: oddsDraw,
        away_open: oddsAway,
        timestamp: Date.now(),
        home_min: oddsHome,
        home_max: oddsHome,
        away_min: oddsAway,
        away_max: oddsAway,
        samples: 1,
      })
      // Then do first update
      const result = analyzer.updateOdds(matchId, oddsHome, oddsDraw, oddsAway)
      return res.json({ success: true, result })
    }
    const result = analyzer.updateOdds(matchId, oddsHome, oddsDraw, oddsAway)
    res.json({ success: true, result })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

module.exports = router
