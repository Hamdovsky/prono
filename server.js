if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config()
}

const http = require('http')
const logger = require('./core/logger')
const PORT = process.env.PORT || 10000

// ── Immediate health-check HTTP server (responds BEFORE Express loads) ──
const server = http.createServer((req, res) => {
  if (req.url === '/api/health' || req.url === '/health' || req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', mode: 'loading', uptime: process.uptime() }))
    return
  }
  if (server._expressApp) {
    return server._expressApp(req, res)
  }
  res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' })
  res.end(JSON.stringify({ error: 'Titanium AI initializing', retryAfter: 5 }))
})

server.listen(PORT, '0.0.0.0', () => {
  if (!process.env.LOG_DISABLED) {
    logger.info(`🚀 Health check listener ready on port ${PORT}`)
    logger.info(
      `[BOOT] PID=${process.pid}, HEAP_LIMIT=${process.env.NODE_OPTIONS || 'default'}, MEM_LIMIT=${require('v8').getHeapStatistics().heap_size_limit}`
    )
  }
})

// ── Safety timeout: force startServer() after 3 min no matter what ──
const SAFETY_TIMEOUT_MS = 180000
let safetyTimer = setTimeout(() => {
  logger.warn(`[SAFETY] ${SAFETY_TIMEOUT_MS / 1000}s elapsed — forcing startServer()`)
  if (!server.listening) startServer()
}, SAFETY_TIMEOUT_MS)

// ── Load Express app asynchronously (background, non-blocking) ──
setTimeout(async () => {
  try {
    const app = require('./app')
    server._expressApp = app

    const memoryManager = require('./core/memoryManager')
    const startupBootstrap = require('./core/startupBootstrap')
    const apiKeysValidator = require('./core/apiKeysValidator')
    const apiSourceRegistry = require('./core/apiSourceRegistry')
    const enrichmentCycle = require('./core/enrichmentCycle')
    const settlementCycle = require('./core/settlementCycle')
    const cronSchedules = require('./core/cronSchedules')
    const diagnostics = require('./core/diagnostics')

    const database = require('./core/database')
    const socketService = require('./services/socketService')
    const mlPredictionService = require('./services/mlPredictionService')
    const cronManager = require('./services/cronManager')
    const backupService = require('./backup_service')
    const botService = require('./services/botService')
    const supabaseService = require('./services/supabaseService')
    const apiFallbackManager = require('./services/apiFallbackManager')
    const autoHealAgent = require('./services/autoHealAgent')
    const retroSync = require('./services/retroSyncService')
    const clvService = require('./services/clvService')
    const _redisClient = require('./core/redisClient')

    const redisCache = {
      get: _redisClient.getCache,
      set: (key, value, ttl) => _redisClient.setCache(key, value, ttl),
      init: () => Promise.resolve(),
      ..._redisClient,
    }

    // ── Socket.io ──
    socketService.init(server)

    const getMLPrediction = (match) => mlPredictionService.getMLPrediction(match)

    // ── Startup ──
    ;(async () => {
      try {
        await startupBootstrap.runAll({ port: PORT })

        // ── API Keys validation ──
        const keyStatus = apiKeysValidator.validateKeys()

        // ── Memory management ──
        memoryManager.startPeriodicCheck(60000)

        // ── Services startup ──
        if (process.env.DISABLE_BACKUP !== 'true') backupService.startAutomatedBackups()
        if (process.env.TELEGRAM_BOT_TOKEN) {
          botService.startPolling()
        } else {
          logger.warn('[STARTUP] TELEGRAM_BOT_TOKEN not set — bot polling disabled')
        }
        await redisCache.init().catch((e) => logger.warn(`Redis error: ${e.message}`))

        // Deferred cron init
        setTimeout(() => {
          try {
            cronManager.init(socketService)
          } catch (e) {
            logger.warn(`[CRON] Init error: ${e.message}`)
          }
        }, 10000)

        // ── API Source Registration ──
        apiSourceRegistry.registerAll(apiFallbackManager, {
          bsd: require('./services/bsdService'),
          therundown: require('./services/therundownService'),
          oddspapi: require('./services/oddspapiService'),
          sportmonks: require('./services/sportmonksService'),
          apifootball: require('./services/apifootballService'),
          openligadb: require('./services/openligadbService'),
          predixSport: require('./services/predixSportService'),
          bigBallsData: require('./services/bigBallsDataService'),
          oddsApiIo: require('./services/oddsApiIoService'),
          futpython: require('./services/futpythonService'),
          clearSports: require('./services/clearSportsService'),
          sportApi: require('./services/sportApiService'),
          apiNinjas: require('./services/apiNinjasService'),
        })

        // ── Cycles ──
        enrichmentCycle.startPeriodicEnrichment({})
        settlementCycle.startSettlementCycle()

        // ── Background services ──
        await Promise.race([
          retroSync.syncPastMatches(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 60000)),
        ]).catch((e) => logger.warn(`[RETROSYNC] Error: ${e.message}`))
        clvService.start().catch((e) => logger.warn(`[CLV] Error: ${e.message}`))
        const scrapedOddsService = require('./services/scrapedOddsService')
        scrapedOddsService
          .ensureTable()
          .catch((e) => logger.warn(`[SCRAPED_ODDS] Init: ${e.message}`))

        // ── Supabase sync ──
        setTimeout(async () => {
          try {
            const connected = await supabaseService.connect()
            if (connected) {
              await supabaseService.initSchema()
              await supabaseService.restoreToSQLite(database)
              await supabaseService.syncFromSQLite(database)
              const { query: pgRaw } = require('./core/pg_connector')
              await pgRaw(`DELETE FROM matches WHERE source IN ('seed', 'emergency')`).catch(
                () => {}
              )
              await database
                .exec("DELETE FROM matches WHERE source IN ('seed', 'emergency')")
                .catch(() => {})
              logger.info('[SUPABASE] Purged old demo seeds')
              supabaseService.startPeriodicSync(database)
              logger.info('[SUPABASE] Dual-sync active')
            }
          } catch (e) {
            logger.warn(`[SUPABASE] Init error: ${e.message}`)
          }
        }, 5000)

        database.cleanupPlaceholderTeams()
        setTimeout(() => {
          try {
            supabaseService.cleanupPlaceholderTeams()
          } catch (_) {}
        }, 15000)

        // ── Cron schedules ──
        cronSchedules.init()

        // ── Auto-enrich after cloud seed (batched to avoid OOM on free tier) ──
        const ENRICH_BATCH = parseInt(process.env.ENRICH_BATCH_SIZE || '20', 10)
        const ENRICH_DELAY = parseInt(process.env.ENRICH_BATCH_DELAY_MS || '300000', 10) // 5 min

        async function enrichBatch(batchSize) {
          const enrichedPredictions = require('./core/enriched_predictions')
          const matches = await database.getMatchesByStatus('scheduled')
          if (matches.length === 0) return 0
          const batch = matches.slice(0, batchSize)
          logger.info(`[AUTO-ENRICH] Batch: ${batch.length}/${matches.length} matches...`)
          const enriched = await enrichedPredictions.enrichMatches(batch, {
            fastMode: true,
            force: true,
          })
          let updated = 0
          for (const m of enriched) {
            if (m.expected_score && m.expected_score !== 'N/A') {
              await database.updatePredictions(m.id, m)
              updated++
            }
          }
          logger.info(`[AUTO-ENRICH] Updated ${updated}/${batch.length}`)
          return updated
        }

        setTimeout(async function runEnrichBatches() {
          try {
            const remaining = await database.getMatchesByStatus('scheduled')
            if (remaining.length === 0) {
              logger.info(`[AUTO-ENRICH] All matches enriched, stopping.`)
              return
            }
            await enrichBatch(ENRICH_BATCH)
            setTimeout(runEnrichBatches, ENRICH_DELAY)
          } catch (e) {
            logger.warn(`[AUTO-ENRICH] Error: ${e.message}`)
            setTimeout(runEnrichBatches, ENRICH_DELAY)
          }
        }, 15000)

        // ── AutoHeal patrol ──
        setTimeout(() => {
          autoHealAgent.patrol().catch((e) => logger.warn(`[AUTOHEAL] Patrol error: ${e.message}`))
        }, 30000)

        // ── Startup auto-backtest (30s after boot, then daily cron handles it) ──
        setTimeout(async () => {
          try {
            const { runAutoBacktest } = require('./services/autoBacktestService')
            const result = await runAutoBacktest()
            if (result && result.totalMatches > 0) {
              logger.info(
                `[AUTO-BACKTEST] Startup: ${result.totalMatches} matches, accuracy=${result.overall?.accuracy}%`
              )
            }
          } catch (e) {
            logger.warn(`[AUTO-BACKTEST] Startup: ${e.message}`)
          }
        }, 30000)

        // ── Diagnostic ──
        diagnostics.scheduleDailyDiagnose(10000)
        apiKeysValidator.logAvailability()

        // ── Server binding ──
        clearTimeout(safetyTimer)
        startServer()
      } catch (initErr) {
        logger.error(`💥 [CRITICAL] Startup error: ${initErr.message}`)
        clearTimeout(safetyTimer)
        try {
          startServer()
        } catch (e2) {
          logger.error(`💥 [FATAL] startServer error: ${e2.message}`)
          process.exit(1)
        }
      }
    })()
  } catch (expressErr) {
    logger.error(`💥 [EXPRESS] Async load error: ${expressErr.message}`)
    clearTimeout(safetyTimer)
    try { logger.error('STACK_TRACE: ' + (expressErr.stack || '').slice(0, 1500)) } catch (_) {}
  }
}, 2000)

const startServer = (retries = 5, host = '0.0.0.0') => {
  function afterListen() {
    logger.info(`🚀 Titanium Server listening at http://${host}:${PORT}`)
    logger.info('✅ API GATEWAY ACTIVE')
  }
  if (server.listening) {
    afterListen()
    return
  }
  server.listen(PORT, host, afterListen).on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      if (retries > 0) {
        logger.warn(`⚠️  Port ${PORT} in use, retrying in 2s... (${retries} left)`)
        await startupBootstrap.killProcessOnPort(PORT)
        setTimeout(() => startServer(retries - 1), 2000)
      } else {
        logger.error(`💥 [FATAL] Port ${PORT} persistently occupied`)
        process.exit(1)
      }
    } else if (host === '0.0.0.0') {
      setTimeout(() => startServer(retries, undefined), 500)
    } else {
      logger.error(`💥 [FATAL] Server Error: ${err.message}`)
      process.exit(1)
    }
  })
}

process.on('uncaughtException', (err) => {
  const msg = `💥 [FATAL] Uncaught Exception: ${err.message}`
  try {
    logger.error(msg, { stack: err.stack })
  } catch (_) {
    logger.error(msg)
  }
  try {
    console.error('[CRASH]', err.stack || err.message)
  } catch (_) {}
  try {
    require('fs').appendFileSync(
      '/tmp/crash.log',
      JSON.stringify({
        time: Date.now(),
        type: 'uncaughtException',
        msg: err.message,
        stack: err.stack,
      }) + '\n'
    )
  } catch (_) {}
  setTimeout(() => process.exit(1), 1000)
})

process.on('unhandledRejection', (reason) => {
  const msg = `💥 UNHANDLED REJECTION: ${reason instanceof Error ? reason.message : String(reason)}`
  try {
    logger.error(msg)
  } catch (_) {
    logger.error(msg)
  }
  try {
    console.error('[REJECTION]', reason instanceof Error ? reason.stack : String(reason))
  } catch (_) {}
  try {
    require('fs').appendFileSync(
      '/tmp/crash.log',
      JSON.stringify({
        time: Date.now(),
        type: 'unhandledRejection',
        msg: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : '',
      }) + '\n'
    )
  } catch (_) {}
})

const shutDown = () => {
  logger.info('🛑 Shutting down gracefully')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10000)
}

process.on('SIGTERM', shutDown)
process.on('SIGINT', shutDown)
