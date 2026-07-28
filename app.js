// ─── Env validation (non-blocking) ────────────────────
const MISSING_CRITICAL = [
  ['API_SECRET_KEY', 'API Secret Key'],
  ['DATABASE_URL', 'PostgreSQL URL'],
].filter(([key]) => !process.env[key] || process.env[key].startsWith('CHANGER_MOI'))
if (MISSING_CRITICAL.length > 0 && !process.env.JEST_WORKER_ID) {
  console.warn("⚠️  [ENV] Variables d'environnement critiques manquantes:")
  MISSING_CRITICAL.forEach(([, name]) => console.warn(`   ⚠️  ${name}`))
}

const http = require('http')
const v8 = require('v8')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const express = require('express')
const cors = require('cors')
// compression removed — Render proxy handles gzip natively
const promBundle = require('express-prom-bundle')

// Core Engines
const logger = require('./core/logger')
const database = require('./core/database')
const configEngine = require('./core/configEngine')
const securityEngine = require('./core/securityEngine')
const shieldEngine = require('./core/shieldEngine')
const { sanitizeMatches } = require('./core/matchSanitizer')

// Metrics
const {
  httpRequestsTotal,
  activeConnections,
  circuitBreakerState,
  cacheHits,
  cacheMisses,
  register,
} = require('./core/metrics')

// Business Services
const backupService = require('./backup_service')
const comboService = require('./services/comboService')
const botService = require('./services/botService')
const mlPredictionService = require('./services/mlPredictionService')
const socketService = require('./services/socketService')
const cronManager = require('./services/cronManager')

// Auto-Heal Agent
const autoHealAgent = require('./services/autoHealAgent')

// Supabase (PostgreSQL cloud — données persistantes)
const supabaseService = require('./services/supabaseService')

// API Fallback Manager
const apiFallbackManager = require('./services/apiFallbackManager')
const marketAnalysis = require('./services/marketAnalysisService')

// Secondary Services
const _redisClient = require('./core/redisClient')
// Normalize API: redisClient exports getCache/setCache; alias to .get/.set for middleware
const redisCache = {
  get: _redisClient.getCache,
  set: (key, value, ttl) => _redisClient.setCache(key, value, ttl),
  init: () => Promise.resolve(), // redisClient has no init — connection is lazy
  ..._redisClient,
}
const { validate, SeedMatchSchema, EloUpdateSchema, ScrapeTriggerSchema, LearnSchema, LearnBatchSchema, ConfigSchema, BackfillSchema, ScraperToggleSchema } = require('./core/validation')
const scraperApiService = require('./services/scraperApiService')
const playerPropsService = require('./services/playerPropsService')

// Import Modular Routers
const learnRoutes = require('./routes/learn')
const comboRoutes = require('./routes/combos')
const systemRoutes = require('./routes/system')
const analyticsRoutes = require('./routes/analytics')
const scraperRoutes = require('./routes/scraper')
const evolutionRoutes = require('./routes/evolution')
const integrationRoutes = require('./routes/integration')
const matchesRoutes = require('./routes/matches')
const promosportRoutes = require('./routes/promosport')
const dsRoutes = require('./routes/ds')
const gridRoutes = require('./routes/gridRoutes')

// Swagger API Documentation
let swaggerUi, swaggerSpecs
try {
  const swaggerConfig = require('./config/swagger')
  swaggerUi = swaggerConfig.swaggerUi
  swaggerSpecs = swaggerConfig.specs
} catch (err) {
  logger.warn('⚠️ Swagger config not found - API docs disabled')
}

const app = express()
app.set('trust proxy', 1) // Honor X-Forwarded-For (Render proxy)

// Prometheus metrics middleware — use shared register to avoid duplicate metric errors on restart
let metricsMiddleware
try {
  metricsMiddleware = promBundle({
    includeMethod: true,
    includePath: true,
    customLabels: { project: 'titanium', type: 'api' },
    promClient: { collectDefaultMetrics: { register } },
    promRegistry: register,
  })
  app.use(metricsMiddleware)
} catch (e) {
  logger.warn('📊 [METRICS] Middleware failed to initialize:', e.message)
}

// CORS - restrict in production but allow native smartphone containers
const allowedOrigins = [
  'https://prono-k6gc.onrender.com',
  'https://prono-k6gc-rxjf.onrender.com',
  'https://prono-api-7mhs.onrender.com',
  'http://localhost',
  'https://localhost',
  'capacitor://localhost',
]

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile native HTTP clients, curl, postman)
    if (!origin) return callback(null, true)

    // Check if origin is in the allowed list or is a local address
    const isAllowed =
      allowedOrigins.includes(origin) ||
      origin.startsWith('http://localhost:') ||
      origin.startsWith('https://localhost:') ||
      origin.startsWith('http://127.0.0.1:') ||
      process.env.NODE_ENV !== 'production'

    if (isAllowed) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
}
app.use(cors(corsOptions))

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// 🛡️ SECURITY HEADERS (helmet)
try {
  const helmet = require('helmet')
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "'unsafe-inline'",
            'cdn.tailwindcss.com',
            'cdnjs.cloudflare.com',
            'pagead2.googlesyndication.com',
            'googleads.g.doubleclick.net',
            'www.googletagservices.com',
            '*.googlesyndication.com',
            '*.google.com',
            '*.g.doubleclick.net',
          ],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            'fonts.googleapis.com',
            '*.googlesyndication.com',
          ],
          fontSrc: ["'self'", 'fonts.gstatic.com'],
          imgSrc: [
            "'self'",
            'data:',
            'https:',
            '*.googlesyndication.com',
            '*.doubleclick.net',
            '*.google.com',
          ],
          frameSrc: [
            "'self'",
            '*.googlesyndication.com',
            '*.doubleclick.net',
            '*.google.com',
            'pagead2.googlesyndication.com',
            'googleads.g.doubleclick.net',
            'www.googletagservices.com',
          ],
          connectSrc: ["'self'", 'ws:', 'wss:', 'http:', 'https:'],
        },
      },
      hsts: { maxAge: 31536000, includeSubDomains: true },
      crossOriginEmbedderPolicy: false,
    })
  )
  console.log('🛡️ [SECURITY] HTTP security headers (helmet) active')
} catch (_) {
  console.warn('⚠️ [SECURITY] helmet not installed — run: npm install helmet')
}

const { predictLimiter, writeLimiter } = require('./core/securityEngine')

// Global rate-limit on all /api/ routes
app.use('/api', securityEngine.middleware.bind(securityEngine))
// Origin validation for non-GET, non-authed requests
app.use(securityEngine.validateOrigin.bind(securityEngine))

app.use(async (req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    try {
      const latency = Date.now() - start
      shieldEngine.updateStatus(latency)

      const routePath = req.route?.path || req.path
      const labelRoute = typeof routePath === 'string' ? routePath : String(routePath)

      httpRequestsTotal.inc({
        method: req.method,
        route: labelRoute,
        status_code: String(res.statusCode),
      })
    } catch (err) {
      // Metrics should never crash the request lifecycle
    }
  })
  next()
})

// --- CACHING MIDDLEWARE with circuit breaker ---
const redisMiddleware = async (req, res, next) => {
  try {
    const key = `express_cache:${req.originalUrl}`
    const cachedData = await redisCache.get(key)
    if (cachedData) {
      cacheHits.inc()
      return res.json(cachedData)
    }

    res.sendResponse = res.json
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cacheMisses.inc()
        redisCache.set(key, body, 60).catch(() => {})
      }
      res.sendResponse(body)
    }
    next()
  } catch (e) {
    cacheMisses.inc()
    next()
  }
}

// ── CORE API ENDPOINTS ─────────────────────────────────────────
// Fast health check for Render (no DB/Redis/FastAPI dependency)
app.get('/ping', (req, res) => res.status(200).send('pong'))
app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }))
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  })
})

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType)
  res.end(await register.metrics())
})

app.get('/api/diag', securityEngine.authenticate.bind(securityEngine), async (req, res) => {
  const db = database.db
  async function q(sql) {
    try {
      const r = await db?.prepare(sql).all()
      return { ok: true, rows: r }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }
  const statuses = await q(
    'SELECT status, COUNT(*) as c FROM matches GROUP BY status ORDER BY c DESC'
  )
  const sample = await q('SELECT * FROM matches LIMIT 5')
  const bsdSample = await q(
    "SELECT * FROM matches WHERE source = 'bsd' AND status = 'NOT_STARTED' LIMIT 5"
  )
  const dbTotalRow = await db?.prepare('SELECT COUNT(*) as c FROM matches').get()
  res.json({
    bsdAvailable: bsdService.isAvailable(),
    dbTotal: dbTotalRow?.c || 0,
    statuses,
    sample,
    bsdSample,
  })
})

app.post(
  '/api/debug/test-bsd',
  writeLimiter,
  securityEngine.authenticate.bind(securityEngine),
  async (req, res) => {
    try {
      const bsd = require('./services/bsdService')
      // Test the BSD API directly with a simple fetch
      const axios = require('axios')
      const testResult = await axios.get('https://sports.bzzoiro.com/api/v2/events/?limit=3', {
        headers: { Authorization: `Token ${process.env.BSD_API_KEY}`, Accept: 'application/json' },
        timeout: 15000,
      })
      const data = testResult.data
      res.json({
        available: bsd.isAvailable(),
        statusCode: testResult.status,
        hasResults: !!data?.results,
        resultCount: data?.results?.length || 0,
        firstEvent: data?.results?.[0]
          ? {
              id: data.results[0].id,
              start_timestamp: data.results[0].start_timestamp,
              home: data.results[0].home_team,
            }
          : null,
        lastEvent: data?.results?.[data.results.length - 1]
          ? {
              id: data.results[data.results.length - 1].id,
              start_timestamp: data.results[data.results.length - 1].start_timestamp,
            }
          : null,
      })
    } catch (e) {
      res.json({ error: e.message, status: e.response?.status, data: e.response?.data })
    }
  }
)

app.post(
  '/api/seed/emergency',
  writeLimiter,
  securityEngine.authenticate.bind(securityEngine),
  async (req, res) => {
    try {
      const db = require('./core/database')
      const { seedDemoMatches } = require('./scripts/seed_emergency')
      const count = await seedDemoMatches(db)
      res.json({ success: true, message: `Seeded ${count} matches via emergency seed` })
    } catch (e) {
      res.status(500).json({ success: false, error: e.message })
    }
  }
)

app.post(
  '/api/seed/purge',
  writeLimiter,
  securityEngine.authenticate.bind(securityEngine),
  async (req, res) => {
    try {
      const { purgeFakeMatches } = require('./core/cloudSeed')
      const removed = await purgeFakeMatches()
      res.json({ success: true, removed })
    } catch (e) {
      res.status(500).json({ success: false, error: e.message })
    }
  }
)

app.post(
  '/api/seed-match',
  writeLimiter,
  securityEngine.authenticate.bind(securityEngine),
  validate(SeedMatchSchema),
  async (req, res) => {
    try {
      const match = req.validatedBody
      const db = require('./core/database')
      const id = match.id || `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const newMatch = {
        id,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        league: match.league || 'Manual Entry',
        startTimestamp: match.startTimestamp || Math.floor(Date.now() / 1000) + 86400,
        status: 'scheduled',
        confidence: 50,
        prediction: null,
        source: 'manual',
        odds_home: match.odds_home || null,
        odds_draw: match.odds_draw || null,
        odds_away: match.odds_away || null,
        home_win_probability: match.home_win_probability || null,
        draw_probability: match.draw_probability || null,
        away_win_probability: match.away_win_probability || null,
      }
      await db.insertMatch(newMatch)
      res.json({ success: true, id })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  }
)

app.post(
  '/api/debug/backfill',
  writeLimiter,
  securityEngine.authenticate.bind(securityEngine),
  async (req, res) => {
    const { query: pgQuery } = require('./core/pg_connector')
    try {
      const test1 = await pgQuery(
        'SELECT id, "fullData", "startTimestamp" FROM matches WHERE "startTimestamp" IS NULL AND "fullData" IS NOT NULL LIMIT 3'
      )
      const step1 = test1.rows.map((r) => ({
        id: r.id,
        fullData_snippet: (r.fullData || '').slice(0, 150),
        startTs: r.startTimestamp,
      }))

      let step2 = []
      let step3 = {}
      if (test1.rows.length > 0) {
        const test2 = await pgQuery(
          'SELECT id, SUBSTRING("fullData" FROM \'"startTimestamp":([0-9]+)\') AS ts FROM matches WHERE "startTimestamp" IS NULL AND "fullData" IS NOT NULL LIMIT 3'
        )
        step2 = test2.rows.map((r) => ({ id: r.id, ts: r.ts }))

        // Execute the actual backfill UPDATE
        const backfillResult = await pgQuery(
          'UPDATE matches SET "startTimestamp" = SUBSTRING("fullData" FROM \'"startTimestamp":([0-9]+)\')::bigint WHERE "startTimestamp" IS NULL AND "fullData" IS NOT NULL AND "fullData" ~ \'"startTimestamp":[0-9]+\''
        )
        step3 = { rowCount: backfillResult.rowCount }
      }

      const pgDb = require('./core/pg_database')
      const step4 = await pgDb.getMatchesByStatuses(['scheduled'])
      res.json({
        step1,
        step2,
        step3,
        step4_count: step4.length,
        step4_sample: step4
          .slice(0, 2)
          .map((r) => ({ id: r.id, homeTeam: r.homeTeam, startTs: r.startTimestamp })),
      })
    } catch (e) {
      res.json({ error: e.message, stack: (e.stack || '').slice(0, 500) })
    }
  }
)

app.get('/api/audit/performance', async (req, res) => {
  try {
    const auditService = require('./services/auditService')
    res.json(await auditService.getPerformanceSnapshot())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/predict', predictLimiter, async (req, res) => {
  try {
    const match = req.body
    const enrichedPredictions = require('./core/enriched_predictions')
    const result = await enrichedPredictions.enrichMatch(match)
    res.json(result)
  } catch (err) {
    logger.error('❌ [API-PREDICT] Error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.post('/api/re-enrich', securityEngine.authenticate.bind(securityEngine), async (req, res) => {
  try {
    const database = require('./core/database')
    const enrichedPredictions = require('./core/enriched_predictions')
    const matches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS'])
    logger.info(`🔄 [RE-ENRICH] Force re-enriching ${matches.length} matches with JS engine...`)
    const enriched = await enrichedPredictions.enrichMatches(matches, {
      fastMode: true,
      force: true,
    })
    let updated = 0
    for (const m of enriched) {
      if (m.expected_score) {
        await database.updatePredictions(m.id, m)
        updated++
      }
    }
    logger.info(`✅ [RE-ENRICH] Updated ${updated}/${matches.length} matches`)
    res.json({ success: true, total: matches.length, updated })
  } catch (err) {
    logger.error('❌ [RE-ENRICH] Error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

app.post(
  '/api/config',
  securityEngine.authenticate.bind(securityEngine),
  validate.deployConfig,
  async (req, res) => {
    try {
      const newConfig = req.body
      const ALLOWED_KEYS = ['scraperUrl', 'SOURCE_MODE', 'thresholds', 'autoPurge', 'strategy']

      for (const key of Object.keys(newConfig)) {
        if (ALLOWED_KEYS.includes(key)) configEngine.config[key] = newConfig[key]
      }

      if (newConfig.botToken) await configEngine.updateEnv('TELEGRAM_BOT_TOKEN', newConfig.botToken)
      if (newConfig.chatId) await configEngine.updateEnv('TELEGRAM_CHAT_ID', newConfig.chatId)

      await configEngine.save()
      res.json({ success: true, activeConfig: configEngine.config })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  }
)

app.get('/api/props/today', async (req, res) => {
  try {
    res.json({ success: true, props: playerPropsService.getBestPropsToday(30) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/patterns', async (req, res) => {
  try {
    const db = require('./core/database')
    const results = await db.getAllPatterns(100)
    res.json(results)
  } catch (e) {
    res.status(500).json({ error: 'Archive inaccessible' })
  }
})

// ── MOUNT MODULAR ROUTERS ─────────────────
app.use('/api/learn', learnRoutes)
app.use('/api/combos', comboRoutes)
app.use('/api', systemRoutes)
app.use('/api', analyticsRoutes)
app.use('/api/evolution', evolutionRoutes)
app.use('/api', scraperRoutes)
app.use('/api', matchesRoutes)
app.use('/api/promosport', promosportRoutes)
app.use('/api/grids', gridRoutes)
app.use('/api/results', require('./routes/results'))
app.use('/api/auth', require('./routes/auth'))
app.use('/api', require('./routes/valueBets'))
app.use('/api/bets', require('./routes/bets'))
app.use('/api/training', require('./routes/training'))

// ── SWAGGER API DOCUMENTATION ─────────────────
if (swaggerUi && swaggerSpecs) {
  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpecs, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'Titanium AI API Docs',
      customfavIcon: '/favicon.ico',
    })
  )
  logger.info('📚 [SWAGGER] API Documentation available at /api-docs')
}

// ── SKILLS ENDPOINT ─────────────────────
app.get('/api/skills', (req, res) => {
  const skillsDir = path.join(__dirname, '.agents', 'skills')
  try {
    if (!fs.existsSync(skillsDir)) {
      return res.json({ skills: [] })
    }
    const items = fs.readdirSync(skillsDir, { withFileTypes: true })
    const skills = items.filter((d) => d.isDirectory()).map((d) => ({ name: d.name }))
    res.json({ skills })
  } catch (err) {
    logger.error('[SKILLS] Failed to read skills directory', err)
    res.json({ skills: [] })
  }
})
app.use('/api/ds', dsRoutes)
app.use('/api/webhook', securityEngine.authenticate.bind(securityEngine), integrationRoutes)
app.use('/api', require('./routes/edge'))
app.use('/dashboard', require('./routes/dashboard'))

// ── IN-MEMORY ERROR TRACKER (lightweight, no external deps) ─────
const errorTracker = { errors: [], maxEntries: 200 }
function trackError(status, method, url, message) {
  errorTracker.errors.unshift({ status, method, url, message, at: new Date().toISOString() })
  if (errorTracker.errors.length > errorTracker.maxEntries)
    errorTracker.errors.length = errorTracker.maxEntries
}

app.get('/api/errors/recent', securityEngine.authenticate.bind(securityEngine), (req, res) => {
  const since = req.query.since ? new Date(req.query.since).getTime() : Date.now() - 3600000
  const filtered = errorTracker.errors.filter((e) => new Date(e.at).getTime() >= since)
  res.json({ total: filtered.length, errors: filtered.slice(0, 50) })
})

// ── GLOBAL ERROR HANDLER ──────────────────
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500

  trackError(status, req.method, req.url, err.message)
  logger.error(`💥 [GLOBAL ERROR] ${req.method} ${req.url} - Status: ${status}`, err)

  if (res.headersSent) {
    return next(err)
  }

  res.status(status).json({
    error: 'Internal Server Error',
    message: err.message,
    path: req.url,
    timestamp: new Date().toISOString(),
  })
})

// 🤖 AUTO-HEAL ENDPOINTS
app.get('/api/autoheal/status', (req, res) => {
  res.json(autoHealAgent.getStatus())
})

app.post(
  '/api/autoheal/patrol',
  securityEngine.authenticate.bind(securityEngine),
  async (req, res) => {
    try {
      const result = await autoHealAgent.triggerPatrol()
      res.json(result)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  }
)

app.get('/api/autoheal/history', (req, res) => {
  const remedies = require('./services/autoHealRemedies')
  res.json({ history: remedies.getHistory() })
})

app.get('/api/fallback/status', (req, res) => {
  res.json(apiFallbackManager.getAllStatus())
})

// ─── Fallback Enricher (pure JS — no Python dependency) ──
const fallbackEnricher = require('./core/fallback_enricher')
const settlementService = require('./services/settlementService')

app.post('/api/cron/auto-enrich', async (req, res) => {
  logger.info('[API] ⏰ UptimeRobot triggered fallback enrichment...')
  try {
    const result = await fallbackEnricher.enrichMatchesBatch()
    return res.status(200).json({ success: true, ...result })
  } catch (e) {
    logger.error(`[API] auto-enrich failed: ${e.message}`)
    return res.status(500).json({ success: false, error: e.message })
  }
})

// Also expose a GET variant for simple uptime pings
app.get('/api/cron/auto-enrich', async (req, res) => {
  logger.info('[API] ⏰ Fallback enrichment triggered via GET...')
  try {
    const result = await fallbackEnricher.enrichMatchesBatch()
    return res.status(200).json({ success: true, ...result })
  } catch (e) {
    logger.error(`[API] auto-enrich GET failed: ${e.message}`)
    return res.status(500).json({ success: false, error: e.message })
  }
})

// ─── Settlement Engine (UptimeRobot / cron-job.org friendly) ──
app.post('/api/cron/settle', async (req, res) => {
  logger.info('[API] ⏰ Settlement triggered...')
  try {
    const result = await settlementService.settleFinishedMatches()
    return res.status(200).json({ success: true, ...result })
  } catch (e) {
    logger.error(`[API] Settlement failed: ${e.message}`)
    return res.status(500).json({ success: false, error: e.message })
  }
})

app.get('/api/cron/settle', async (req, res) => {
  logger.info('[API] ⏰ Settlement triggered via GET...')
  try {
    const result = await settlementService.settleFinishedMatches()
    return res.status(200).json({ success: true, ...result })
  } catch (e) {
    logger.error(`[API] Settlement GET failed: ${e.message}`)
    return res.status(500).json({ success: false, error: e.message })
  }
})

// ─── Analytics ──
app.get('/api/analytics/performance', async (req, res) => {
  try {
    const data = settlementService.getPerformance()
    return res.status(200).json({ success: true, ...data })
  } catch (e) {
    logger.error(`[API] /api/analytics/performance failed: ${e.message}`)
    return res.status(500).json({ success: false, error: e.message })
  }
})

app.get('/api/leagues', async (req, res) => {
  try {
    res.json(await database.getAllLeaguesConfig())
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// ─── GoalModel MLE Fit (queries local DB, fits on FastAPI) ──
app.post(
  '/api/goalmodel/fit',
  securityEngine.authenticate.bind(securityEngine),
  async (req, res) => {
    try {
      const Database = require('better-sqlite3')
      const leagueFilter = req.body?.leagues || []

      // Query local SQLite
      const matchesData = {}
      const dbFiles = [
        path.join(__dirname, 'data', 'historical_archive.sqlite'),
        path.join(__dirname, 'data', 'tactical.db'),
      ]
      let db = null
      for (const f of dbFiles) {
        if (fs.existsSync(f)) {
          try {
            db = new Database(f)
            break
          } catch (e) {}
        }
      }
      if (db) {
        const tables = ['archive_matches', 'historical_matches', 'matches', 'historical_batch']
        for (const tbl of tables) {
          let cols = db
            .prepare(`PRAGMA table_info(${tbl})`)
            .all()
            .map((c) => c.name)
          if (cols.length === 0) {
            try {
              const stmt = db.prepare(`SELECT * FROM ${tbl} LIMIT 0`)
              cols = stmt.columns().map((c) => c.name)
            } catch (e2) {}
          }
          if (cols.length === 0) continue
          const hasScoreHome = cols.includes('scoreHome')
          const hasScoreAway = cols.includes('scoreAway')
          const hasHomeTeam = cols.includes('homeTeam')
          if (!hasScoreHome || !hasHomeTeam) continue
          const leagueCol = cols.includes('tournament_name')
            ? 'tournament_name'
            : cols.includes('league')
              ? 'league'
              : null
          const tsCol = cols.includes('startTimestamp')
            ? 'startTimestamp'
            : cols.includes('timestamp')
              ? 'timestamp'
              : null
          if (!leagueCol || !tsCol) continue
          const leagues =
            leagueFilter.length > 0
              ? leagueFilter
              : db
                  .prepare(
                    `SELECT "${leagueCol}" AS league_name FROM ${tbl} WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL GROUP BY "${leagueCol}" HAVING COUNT(*) >= 5 ORDER BY COUNT(*) DESC LIMIT 5`
                  )
                  .all()
                  .map((r) => r.league_name)
          for (const league of leagues) {
            if (matchesData[league]) continue
            const rows = db
              .prepare(
                `SELECT homeTeam, awayTeam, scoreHome, scoreAway, "${tsCol}" AS ts FROM ${tbl} WHERE "${leagueCol}" = ? AND scoreHome IS NOT NULL AND scoreAway IS NOT NULL ORDER BY ts DESC LIMIT 100`
              )
              .all(league)
            if (rows.length >= 10) {
              matchesData[league] = rows.map((r) => ({
                homeTeam: r.homeTeam,
                awayTeam: r.awayTeam,
                scoreHome: r.scoreHome || 0,
                scoreAway: r.scoreAway || 0,
                timestamp: r.ts || new Date().toISOString(),
              }))
            }
          }
        }
        db.close()
      }

      if (Object.keys(matchesData).length === 0) {
        return res.json({ success: true, fitted: 0, total: 0, note: 'No match data found' })
      }

      // Send to FastAPI for fitting
      const fastApiUrl = process.env.INFERENCE_URL || 'https://prono-fastapi.onrender.com'
      const httpMod = fastApiUrl.startsWith('https') ? require('https') : require('http')
      const callbackUrl =
        (process.env.VITE_API_URL || 'https://prono-k6gc.onrender.com') + '/api/goalmodel/callback'
      const body = JSON.stringify({
        leagues: Object.keys(matchesData),
        matches_data: matchesData,
        callback_url: callbackUrl,
      })

      const result = await new Promise((resolve, reject) => {
        const urlObj = new URL(fastApiUrl.replace(/\/+$/, '') + '/goalmodel/fit')
        const opts = {
          hostname: urlObj.hostname,
          port: urlObj.port || 443,
          path: urlObj.pathname + urlObj.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 300000,
        }
        const req = httpMod.request(opts, (r) => {
          let data = ''
          r.on('data', (chunk) => (data += chunk))
          r.on('end', () => {
            if (r.statusCode >= 400) {
              return resolve({ error: `HTTP ${r.statusCode}`, body: data })
            }
            try {
              resolve(JSON.parse(data))
            } catch (e) {
              resolve({ raw: data, status: r.statusCode })
            }
          })
        })
        req.on('error', reject)
        req.on('timeout', () => {
          req.destroy()
          reject(new Error('Timeout'))
        })
        req.write(body)
        req.end()
      })
      res.json({ success: true, ...result })
    } catch (e) {
      res.status(500).json({ success: false, error: e.message })
    }
  }
)

// ─── Callback: receive fitted GoalModel params from FastAPI → DB ──
app.post(
  '/api/goalmodel/callback',
  securityEngine.authenticate.bind(securityEngine),
  async (req, res) => {
    try {
      const {
        league,
        mu,
        hfa,
        rho,
        gamma,
        model,
        distribution_type,
        num_matches,
        teams,
        attack_ratings,
        defense_ratings,
      } = req.body
      if (!league) return res.status(400).json({ error: 'league required' })
      const now = new Date().toISOString()
      const dist = distribution_type || 'poisson'
      // Save league-level summary as a row with team_name=null
      await database.upsertGoalModelParameter({
        tournament_name: league,
        team_name: null,
        attack_rating: 0,
        defense_rating: 0,
        hfa: hfa || 0.25,
        rho: rho ?? -0.12,
        mu: mu || 0.13,
        distribution_type: dist,
        num_matches: num_matches || 0,
        updated_at: now,
      })
      // Save per-team attack/defense ratings
      if (teams && Array.isArray(teams)) {
        for (const team of teams) {
          await database.upsertGoalModelParameter({
            tournament_name: league,
            team_name: team,
            attack_rating: (attack_ratings && attack_ratings[team]) || 0,
            defense_rating: (defense_ratings && defense_ratings[team]) || 0,
            hfa: hfa || 0.25,
            rho: rho ?? -0.12,
            mu: mu || 0.13,
            distribution_type: dist,
            num_matches: num_matches || 0,
            updated_at: now,
          })
        }
      }
      res.json({
        success: true,
        league,
        teams: teams?.length || 0,
        gamma: gamma || 0.0,
        model: model || 'poisson',
      })
    } catch (e) {
      res.status(500).json({ success: false, error: e.message })
    }
  }
)

// ─── Theta Optimizer: run MLE and return per-league NB dispersion params ──
app.get(
  '/api/theta/optimize',
  securityEngine.authenticate.bind(securityEngine),
  async (req, res) => {
    try {
      const thetaOptimizer = require('./services/thetaOptimizer')
      const map = await thetaOptimizer.optimize()
      res.json({
        success: true,
        count: Object.keys(map).length,
        theta: map,
        note: 'theta = dispersion parameter for Negative Binomial (lower = more overdispersion)',
      })
    } catch (e) {
      res.status(500).json({ success: false, error: e.message })
    }
  }
)

// ─── Elo ratings ──
app.get('/api/elo', securityEngine.authenticate.bind(securityEngine), async (req, res) => {
  try {
    const eloService = require('./services/eloRatingService')
    const ratings = eloService.getAllRatings()
    res.json({ success: true, count: ratings.length, ratings: ratings.slice(0, 100) })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/api/elo/update', securityEngine.authenticate.bind(securityEngine), validate(EloUpdateSchema), async (req, res) => {
  try {
    const eloService = require('./services/eloRatingService')
    const { homeTeam, awayTeam, scoreHome, scoreAway } = req.validatedBody
    const result = eloService.updateRatings(homeTeam, awayTeam, scoreHome, scoreAway)
    res.json({ success: true, ...result })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ── LOCAL DATA ENDPOINTS for Render cloud seed (only source) ──
app.get('/api/upcoming', async (req, res) => {
  try {
    const db = require('./core/database')
    const days = parseInt(req.query.days) || 7
    const all = await db.getAllMatches()
    // 🔧 Force seed matches to show as enriched (fullData overrides column in getAllMatches)
    for (const m of all) {
      if (m.source === 'seed') m.insufficient_data = 0
    }
    const now = Math.floor(Date.now() / 1000)
    const maxTs = now + days * 86400
    const upcoming = all.filter((m) => {
      if (m.status !== 'scheduled' && m.status !== 'NOT_STARTED' && m.status !== 'NS') return false
      const ts = m.startTimestamp || 0
      return ts >= now - 86400 && ts <= maxTs
    })

    // 🧹 [DATA SANITIZER] Remove zombie/frozen/corrupted matches
    const { sanitized: cleanMatches, stats: sanitStats } = sanitizeMatches(upcoming)
    if (sanitStats.rejected > 0) {
      logger.info(
        `🧹 [SANITIZER] ${sanitStats.rejected} zombie/corrupted matches removed from upcoming`
      )
    }

    const enriched = cleanMatches.map((m) => {
      try {
        const xgH = parseFloat(m.home_avg_scored || m.xg_home || 1.2)
        const xgA = parseFloat(m.away_avg_scored || m.xg_away || 1.0)
        const hProb = parseFloat(m.home_win_probability || 0.33)
        const dProb = parseFloat(m.draw_probability || 0.33)
        const aProb = parseFloat(m.away_win_probability || 0.33)

        const mkts = marketAnalysis.analyzeAll(m, {
          xgH,
          xgA,
          h: hProb,
          d: dProb,
          a: aProb,
        })

        m.marketAnalysis = {
          overUnder: mkts.overUnder,
          btts: mkts.btts,
          doubleChance: mkts.doubleChance,
          htFt: mkts.htFt.topPick,
          corners: mkts.corners,
          cards: mkts.cards,
          playerProps: mkts.playerProps.slice(0, 3),
        }
      } catch (_) {}
      return m
    })

    res.json({ success: true, count: enriched.length, matches: enriched })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.get('/api/top-picks', async (req, res) => {
  try {
    const fs = require('fs')
    const path = require('path')
    const picksPath = path.join(__dirname, 'data', 'daily_predictions.json')
    if (fs.existsSync(picksPath)) {
      const data = JSON.parse(fs.readFileSync(picksPath, 'utf-8'))
      res.json({ success: true, ...data })
    } else {
      res.json({ success: false, error: 'No predictions yet. Run daily_predictions.py first.' })
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ── AI Scraper Endpoint ──────────────────────────────────────────
app.get('/api/scrape/odds', async (req, res) => {
  try {
    const { home, away, league } = req.query
    if (!home || !away) {
      return res.status(400).json({ success: false, error: 'Missing home or away param' })
    }
    const scrapeService = require('./services/scrapeService')
    const odds = await scrapeService.getOdds(home, away, league || 'Unknown')
    res.json({
      success: !!odds,
      home,
      away,
      league: league || 'Unknown',
      odds,
      cache_size: require('./services/scrapeService').getCacheSize(),
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post(
  '/api/scrape/trigger',
  securityEngine.authenticate.bind(securityEngine),
  express.json(),
  validate(ScrapeTriggerSchema),
  async (req, res) => {
    try {
      const { url, type } = req.validatedBody
      const scrapeService = require('./services/scrapeService')
      const result = await scrapeService.scrapeUrl(url)
      res.json({ success: true, url, type: type || 'auto', ...result })
    } catch (e) {
      res.status(500).json({ success: false, error: e.message })
    }
  }
)

// ── Scraper Toggle & Status ───────────────────────────────────────
app.get('/api/scraper/status', (req, res) => {
  try {
    const router = require('./services/scrapers')
    const status = router.getStatus()
    const fcAvailable = require('./services/scrapers/FirecrawlScraper').isAvailable()
    res.json({
      success: true,
      mode: status.mode,
      firecrawl_configured: fcAvailable,
      firecrawl_key_set: status.firecrawl_key_set,
      active_chain: status.chain,
      health: status.health,
      caches: status.cache_size,
      hint: fcAvailable
        ? 'Firecrawl primary → Jina fallback → Python legacy'
        : 'Jina primary → Python legacy. Add FIRECRAWL_API_KEY to .env for JS-dynamic scraping.',
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post(
  '/api/scraper/toggle',
  securityEngine.authenticate.bind(securityEngine),
  express.json(),
  async (req, res) => {
    try {
      const router = require('./services/scrapers')
      const { mode } = req.body
      if (!mode || !['firecrawl_primary', 'jina_primary'].includes(mode)) {
        return res
          .status(400)
          .json({ success: false, error: 'Mode must be firecrawl_primary or jina_primary' })
      }
      router.setMode(mode)
      res.json({ success: true, mode, note: 'Mode will persist across restarts' })
    } catch (e) {
      res.status(500).json({ success: false, error: e.message })
    }
  }
)

app.post('/api/scraper/reset', securityEngine.authenticate.bind(securityEngine), (req, res) => {
  try {
    const router = require('./services/scrapers')
    router.resetHealth()
    res.json({ success: true, message: 'Health counters reset' })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.get('/api/local/matches', async (req, res) => {
  try {
    const db = require('./core/database')
    const all = await db.getAllMatches()
    const now = Math.floor(Date.now() / 1000)
    const maxTs = now + 3 * 86400
    const upcoming = all.filter((m) => {
      if (m.status !== 'scheduled' && m.status !== 'NOT_STARTED' && m.status !== 'NS') return false
      const ts = m.startTimestamp || 0
      return ts >= now - 86400 && ts <= maxTs
    })
    res.json({ success: true, count: upcoming.length, matches: upcoming })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ─── Auto-Backtest Results (JS) ──
app.get('/api/backtest/results', async (req, res) => {
  try {
    const fs = require('fs')
    const resultsPath = path.join(__dirname, 'data', 'backtest_results.json')
    const trendPath = path.join(__dirname, 'data', 'accuracy_trend.json')
    const weightsPath = path.join(__dirname, 'data', 'league_dynamic_weights.json')
    const latest = fs.existsSync(resultsPath)
      ? JSON.parse(fs.readFileSync(resultsPath, 'utf8'))
      : null
    const trend = fs.existsSync(trendPath)
      ? JSON.parse(fs.readFileSync(trendPath, 'utf8')).slice(-30)
      : []
    const weights = fs.existsSync(weightsPath)
      ? JSON.parse(fs.readFileSync(weightsPath, 'utf8'))
      : {}
    res.json({ success: true, latest, trend, dynamicWeights: weights })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post(
  '/api/backtest/run',
  securityEngine.authenticate.bind(securityEngine),
  async (req, res) => {
    try {
      const { runAutoBacktest } = require('./services/autoBacktestService')
      const result = await runAutoBacktest()
      res.json({ success: true, ...result })
    } catch (e) {
      res.status(500).json({ success: false, error: e.message })
    }
  }
)

app.get('/api/local/all', async (req, res) => {
  try {
    const db = require('./core/database')
    const all = await db.getAllMatches()
    res.json({
      success: true,
      count: all.length,
      stats: {
        scheduled: all.filter(
          (m) => m.status === 'scheduled' || m.status === 'NOT_STARTED' || m.status === 'NS'
        ).length,
        finished: all.filter((m) => m.status === 'finished').length,
        live: all.filter((m) => m.status === 'inprogress' || m.status === 'live').length,
        other: all.filter(
          (m) =>
            !['scheduled', 'NOT_STARTED', 'NS', 'finished', 'inprogress', 'live'].includes(m.status)
        ).length,
      },
      matches: all,
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

const publicPath = path.normalize(path.join(__dirname, 'dist'))
// Serve static assets with cache, but never cache HTML files
app.use(
  express.static(publicPath, {
    setHeaders: (res, path) => {
      if (path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000') // 1 year for js/css/images
      }
    },
  })
)

// Fallback for React Router (SPA)
app.get(/^(?!\/api|\/socket\.io).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.sendFile(path.join(publicPath, 'index.html'), (err) => {
    if (err && !res.headersSent) {
      res.status(404).send('Not Found')
    }
  })
})

module.exports = app
