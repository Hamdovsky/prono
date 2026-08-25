require('dotenv').config()

// Production guard: JWT_SECRET is required on Render to keep sessions stable
// across redeploys. Without it authService.js silently falls back to a random
// value at boot, invalidating every token on restart. Keyed on the real
// platform marker so a stray NODE_ENV=production never blocks local dev.
const isRenderProduction = process.env.RENDER === 'true' || process.env.RENDER === '1'
if (isRenderProduction && !process.env.JWT_SECRET) {
  console.error(
    '[FATAL] JWT_SECRET is not set in production. Add it via Render Dashboard -> Environment -> JWT_SECRET then redeploy.'
  )
  process.exit(1)
}

const http = require('http')
const logger = require('./core/logger')
const PORT = process.env.PORT || 10000
const startupBootstrap = require('./core/startupBootstrap')

// ── Immediate health-check HTTP server (responds BEFORE Express loads) ──
const server = http.createServer((req, res) => {
  if (req.url === '/api/health' || req.url === '/health' || req.url === '/ping') {
    // If Express is up, delegate to its real handlers (accurate status).
    // Otherwise answer "starting" so Render doesn't kill a booting process.
    if (server._expressApp) {
      return server._expressApp(req, res)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'starting', mode: 'loading', uptime: process.uptime() }))
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
const safetyTimer = setTimeout(() => {
  logger.warn(`[SAFETY] ${SAFETY_TIMEOUT_MS / 1000}s elapsed — forcing startServer()`)
  server._expressApp =
    server._expressApp ||
    ((req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '15' })
      res.end(JSON.stringify({ error: 'Titanium AI startup delayed', retryAfter: 15 }))
    })
  if (!server.listening) startServer()
}, SAFETY_TIMEOUT_MS)

// ── Load Express app asynchronously (background, non-blocking) ──
setTimeout(async () => {
  try {
    const app = require('./app')
    server._expressApp = app

    const memoryManager = require('./core/memoryManager')
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
        const ensurePromosportArchive = require('./core/ensurePromosportArchive')
        ensurePromosportArchive.ensurePromosportArchive()
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
          therundown: require('./services/therundownService'),
          oddspapi: require('./services/oddspapiService'),
          sportmonks: require('./services/sportmonksService'),
          openligadb: require('./services/openligadbService'),
          oddsApiIo: require('./services/oddsApiIoService'),
          clearSports: require('./services/clearSportsService'),
          sportApi: require('./services/sportApiService'),
          apiNinjas: require('./services/apiNinjasService'),
        })

        // ── Cycles ──
        // enrichmentCycle.startPeriodicEnrichment({})  // DISABLED: conflicts with independent enrichment loop
        settlementCycle.startSettlementCycle()

        // ── Background services ──
        await Promise.race([
          retroSync.syncPastMatches(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 60000)),
        ]).catch((e) => logger.warn(`[RETROSYNC] Error: ${e.message}`))
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
        try {
          cronSchedules.init()
        } catch (e) {
          logger.warn(`[CRON] Schedules init error: ${e.message}`)
        }

        // ── Auto-enrich after cloud seed (batched to avoid OOM on free tier) ──
        process.env.ENRICH_CONCURRENCY = '8'
        const ENRICH_BATCH = parseInt(process.env.ENRICH_BATCH_SIZE || '35', 10)
        const ENRICH_DELAY = parseInt(process.env.ENRICH_BATCH_DELAY_MS || '10000', 10) // 10s

        async function enrichBatch(batchSize) {
          const enrichedPredictions = require('./core/enriched_predictions')
          const matches = await database.getMatchesByStatuses(
            ['scheduled', 'upcoming', 'NOT_STARTED', 'NS'],
            { limit: 500 }
          )
          if (matches.length === 0) return 0
          const batch = matches.slice(0, batchSize)
          logger.info(`[AUTO-ENRICH] Batch: ${batch.length}/${matches.length} matches...`)
          const enriched = await enrichedPredictions.enrichMatches(batch, {
            fastMode: true,
            force: true,
            skipBayesian: true,
          })
          let updated = 0
          for (const m of enriched) {
            try {
              // Guaranteed minimum prediction floor — never save 0
              const h = parseFloat(m.home_win_probability || 0)
              if (!h || h <= 0 || isNaN(h)) {
                const fb = enrichedPredictions._buildOfflineState(m)
                m.home_win_probability = fb.home_win_probability
                m.draw_probability = fb.draw_probability
                m.away_win_probability = fb.away_win_probability
                m.btts_prob = fb.btts_prob
                m.ou_25_prob = fb.ou_25_prob
                m.ai_source = 'CRON_FALLBACK'
                m.insufficient_data = 1
                if (!m.quant) m.quant = {}
                m.quant.main_pick = fb.quant.main_pick
                m.quant.ev_score = '0.00'
                m.quant.risk_label = fb.quant.risk_label
              }
              // Also guard against NaN in probability fields
              if (isNaN(parseFloat(m.home_win_probability))) m.home_win_probability = 30
              if (isNaN(parseFloat(m.draw_probability))) m.draw_probability = 25
              if (isNaN(parseFloat(m.away_win_probability))) m.away_win_probability = 25
              if (isNaN(parseFloat(m.btts_prob))) m.btts_prob = 40
              if (isNaN(parseFloat(m.ou_25_prob))) m.ou_25_prob = 40
              await database.updatePredictions(m.id, m)
              updated++
            } catch (e) {
              logger.warn(`[AUTO-ENRICH] Save failed for ${m.id}: ${e.message}`)
            }
          }
          logger.info(`[AUTO-ENRICH] Updated ${updated}/${batch.length}`)
          return updated
        }

        setTimeout(async function runEnrichBatches() {
          try {
            const remaining = await database.getMatchesByStatuses(
              ['scheduled', 'upcoming', 'NOT_STARTED', 'NS'],
              { limit: 500 }
            )
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
    server._expressApp = (req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '30' })
      res.end(
        JSON.stringify({ error: 'Express failed to load: ' + expressErr.message, retryAfter: 30 })
      )
    }
    if (!server.listening) startServer()
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

// ── INDEPENDENT ENRICHMENT LOOP (survives init errors) ──
// Uses ONLY synthetic odds + JS QuantumQuantEngine — no Python, no external APIs
setTimeout(() => {
  const database = require('./core/database')
  const { enrichOne } = require('./core/enrichOne')

  async function runLoop() {
    try {
      const matches = await database.getMatchesByStatuses([
        'scheduled',
        'upcoming',
        'NOT_STARTED',
        'NS',
      ])
      const unenriched = matches.filter((m) => {
        const hw = parseFloat(m.home_win_probability || 0)
        const aw = parseFloat(m.away_win_probability || 0)
        // Re-enrich matches that were enriched with old dispersion (ai_source === 'TITANIUM_QUANT_V4' but BTTS < 35 or extreme probs)
        // or have zero/invalid probabilities or no ai_source
        if (m.ai_source === 'TITANIUM_QUANT_V4' && (m.btts_prob < 35 || hw < 8 || aw < 8)) {
          return true
        }
        // Catch matches with no ai_source (null/undefined) — these need enrichment
        if (!m.ai_source || m.ai_source === 'RESPONSE_FLOOR' || m.ai_source === 'NONE') {
          return true
        }
        return !hw || hw <= 0 || isNaN(hw)
      })
      if (unenriched.length === 0) {
        setTimeout(runLoop, 60000) // check again in 1 min
        return
      }
      const batch = unenriched.slice(0, 35)
      let saved = 0
      for (const m of batch) {
        try {
          const enriched = await enrichOne(m)
          await database.updatePredictions(m.id, { ...m, ...enriched })
          saved++
        } catch (e) {
          // skip individual failure
        }
      }
      logger.info(
        `[INDEPENDENT-ENRICH] Saved ${saved}/${batch.length} (remaining: ${unenriched.length - batch.length})`
      )
      setTimeout(runLoop, 5000) // next batch in 5s
    } catch (e) {
      logger.warn(`[INDEPENDENT-ENRICH] Error: ${e.message}`)
      setTimeout(runLoop, 10000)
    }
  }

  setTimeout(runLoop, 30000) // start 30s after server boot
  logger.info('[INDEPENDENT-ENRICH] Loop scheduled (30s delay)')

  // ── PERIODIC FIXTURE SYNC FROM OPENLIGADB (free, no API key) ──
  async function syncOpenLigaDB() {
    try {
      const openligadbService = require('./services/openligadbService')
      if (!openligadbService.isAvailable()) return

      const today = new Date().toISOString().split('T')[0]
      const events = await openligadbService.fetchEvents(today)
      if (events && events.length > 0) {
        let inserted = 0
        for (const event of events) {
          try {
            const result = await database.insertMatch(event)
            if (result) inserted++
          } catch (e) {
            // skip
          }
        }
        if (inserted > 0) {
          logger.info(`[OPENLIGADB-SYNC] Inserted ${inserted} new matches for ${today}`)
        }
      }

      // Also fetch tomorrow's matches
      const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0]
      const events2 = await openligadbService.fetchEvents(tomorrow)
      if (events2 && events2.length > 0) {
        let inserted2 = 0
        for (const event of events2) {
          try {
            const result = await database.insertMatch(event)
            if (result) inserted2++
          } catch (e) {
            // skip
          }
        }
        if (inserted2 > 0) {
          logger.info(`[OPENLIGADB-SYNC] Inserted ${inserted2} new matches for ${tomorrow}`)
        }
      }
    } catch (e) {
      logger.warn(`[OPENLIGADB-SYNC] Error: ${e.message}`)
    }
    setTimeout(syncOpenLigaDB, 6 * 60 * 60 * 1000) // run every 6 hours
  }
  setTimeout(syncOpenLigaDB, 60000) // start 1 min after server boot
  logger.info('[OPENLIGADB-SYNC] Periodic sync scheduled (6h interval)')
}, 0)
