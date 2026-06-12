require('dotenv').config();
const http = require('http');
const v8 = require('v8');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');
// Build trigger: 2026-05-19 11:39
const cors = require('cors');
const compression = require('compression');
const promBundle = require('express-prom-bundle');

// Core Engines
const logger = require('./core/logger');
const database = require('./core/database');
const configEngine = require('./core/configEngine');
const securityEngine = require('./core/securityEngine');
const shieldEngine = require('./core/shieldEngine');

// Metrics
const { httpRequestsTotal, activeConnections, circuitBreakerState, cacheHits, cacheMisses, register } = require('./core/metrics');

// Business Services
const backupService = require('./backup_service');
const comboService = require('./services/comboService');
const botService = require('./services/botService');
const mlPredictionService = require('./services/mlPredictionService');
const patternService = require('./services/patternService');
const socketService = require('./services/socketService');
const cronManager = require('./services/cronManager');

// Auto-Heal Agent
const autoHealAgent = require('./services/autoHealAgent');

// Supabase (PostgreSQL cloud — données persistantes)
const supabaseService = require('./services/supabaseService');

// API Fallback Manager
const apiFallbackManager = require('./services/apiFallbackManager');
const bsdService = require('./services/bsdService');
const therundownService = require('./services/therundownService');
const oddspapiService = require('./services/oddspapiService');
const openligadbService = require('./services/openligadbService');
const sportmonksService = require('./services/sportmonksService');
const apifootballService = require('./services/apifootballService');
const weatherService = require('./services/weatherService');
const bigBallsDataService = require('./services/bigBallsDataService');
const oddsApiIoService = require('./services/oddsApiIoService');
const predixSportService = require('./services/predixSportService');

// Secondary Services
const _redisClient = require('./core/redisClient');
// Normalize API: redisClient exports getCache/setCache; alias to .get/.set for middleware
const redisCache = {
  get: _redisClient.getCache,
  set: (key, value, ttl) => _redisClient.setCache(key, value, ttl),
  init: () => Promise.resolve(), // redisClient has no init — connection is lazy
  ..._redisClient
};
const scraperApiService = require('./services/scraperApiService');
const playerPropsService = require('./services/playerPropsService');
const autoArchiver = require('./services/autoArchiver');
const retroSync = require('./services/retroSyncService');
const clvService = require('./services/clvService');
const adaptiveLearning = require('./services/adaptiveLearningEngine');

const PORT = process.env.PORT || 3001;

// Import Modular Routers
const learnRoutes = require('./routes/learn');
const comboRoutes = require('./routes/combos');
const systemRoutes = require('./routes/system');
const analyticsRoutes = require('./routes/analytics');
const scraperRoutes = require('./routes/scraper');
const evolutionRoutes = require('./routes/evolution');
const integrationRoutes = require('./routes/integration');
const matchesRoutes = require('./routes/matches');
const promosportRoutes = require('./routes/promosport');
const dsRoutes = require('./routes/ds');

console.log('🚀 [STARTUP] INITIALIZING TITANIUM SERVER V3.0...');

const app = express();
module.exports = app; // Export for testing (supertest)
app.set('trust proxy', 1); // Honor X-Forwarded-For (Render proxy)

// Prometheus metrics middleware — use shared register to avoid duplicate metric errors on restart
let metricsMiddleware;
try {
  metricsMiddleware = promBundle({
    includeMethod: true,
    includePath: true,
    customLabels: { project: 'titanium', type: 'api' },
    promClient: { collectDefaultMetrics: { register } },
    promRegistry: register
  });
  app.use(metricsMiddleware);
} catch (e) {
  logger.warn('📊 [METRICS] Middleware failed to initialize:', e.message);
}


app.use(compression());

// CORS - restrict in production but allow native smartphone containers
const allowedOrigins = [
  'https://prono-k6gc.onrender.com',
  'http://localhost',
  'https://localhost',
  'capacitor://localhost'
]

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile native HTTP clients, curl, postman)
    if (!origin) return callback(null, true)
    
    // Check if origin is in the allowed list or is a local address
    const isAllowed = allowedOrigins.includes(origin) ||
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
  credentials: true
}
app.use(cors(corsOptions))

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 🛡️ SECURITY HEADERS (helmet)
try {
  const helmet = require('helmet');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "cdn.tailwindcss.com", "cdnjs.cloudflare.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
        fontSrc: ["'self'", "fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "ws:", "wss:", "http:", "https:"]
      }
    },
    hsts: { maxAge: 31536000, includeSubDomains: true },
    crossOriginEmbedderPolicy: false
  }));
  console.log('🛡️ [SECURITY] HTTP security headers (helmet) active');
} catch (_) {
  console.warn('⚠️ [SECURITY] helmet not installed — run: npm install helmet');
}

// Global rate-limit on all /api/ routes
app.use('/api', securityEngine.middleware.bind(securityEngine))

app.use(async (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    try {
      const latency = Date.now() - start;
      shieldEngine.updateStatus(latency);
      
      const routePath = req.route?.path || req.path;
      const labelRoute = typeof routePath === 'string' ? routePath : String(routePath);
      
      httpRequestsTotal.inc({ 
        method: req.method, 
        route: labelRoute, 
        status_code: String(res.statusCode) 
      });
    } catch (err) {
      // Metrics should never crash the request lifecycle
    }
  });
  next();
});

// --- CACHING MIDDLEWARE with circuit breaker ---
const redisMiddleware = async (req, res, next) => {
  try {
    const key = `express_cache:${req.originalUrl}`;
    const cachedData = await redisCache.get(key);
    if (cachedData) {
      cacheHits.inc();
      return res.json(cachedData);
    }
    
    res.sendResponse = res.json;
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cacheMisses.inc();
        redisCache.set(key, body, 60).catch(() => {});
      }
      res.sendResponse(body);
    };
    next();
  } catch (e) { 
    cacheMisses.inc();
    next(); 
  }
};

// ── CORE API ENDPOINTS ─────────────────────────────────────────
app.get('/health', (req, res) => {
  const circuitBreaker = require('./core/circuitBreaker');
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    memory: process.memoryUsage(),
    circuitBreakers: {
      redis: circuitBreaker.breakers.redis.getState(),
      sofacore: circuitBreaker.breakers.sofacore.getState(),
      database: circuitBreaker.breakers.database.getState(),
      telegram: circuitBreaker.breakers.telegram.getState()
    },
    services: {
      timescale: database.isConnected ? 'connected' : 'disconnected',
      redis: _redisClient.isReady ? 'ready' : 'connecting'
    }
  });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/api/diag', async (req, res) => {
  const db = database.db
  async function q(sql) {
    try { const r = await db?.prepare(sql).all(); return { ok: true, rows: r } }
    catch (e) { return { ok: false, error: e.message } }
  }
  const statuses = await q("SELECT status, COUNT(*) as c FROM matches GROUP BY status ORDER BY c DESC")
  const sample = await q("SELECT * FROM matches LIMIT 5")
  const bsdSample = await q("SELECT * FROM matches WHERE source = 'bsd' AND status = 'NOT_STARTED' LIMIT 5")
  const dbTotalRow = await db?.prepare("SELECT COUNT(*) as c FROM matches").get()
  res.json({
    bsdAvailable: bsdService.isAvailable(),
    dbTotal: dbTotalRow?.c || 0,
    statuses,
    sample,
    bsdSample,
  })
})

app.post('/api/debug/backfill', async (req, res) => {
  const { query: pgQuery } = require('./core/pg_connector')
  try {
    const test1 = await pgQuery('SELECT id, "fullData", "startTimestamp" FROM matches WHERE "startTimestamp" IS NULL AND "fullData" IS NOT NULL LIMIT 3')
    const step1 = test1.rows.map(r => ({
      id: r.id,
      fullData_snippet: (r.fullData || '').slice(0, 150),
      startTs: r.startTimestamp
    }))
    let step2 = []
    if (test1.rows.length > 0) {
      const test2 = await pgQuery('SELECT id, SUBSTRING("fullData" FROM \'"startTimestamp":([0-9]+)\') AS ts FROM matches WHERE "startTimestamp" IS NULL AND "fullData" IS NOT NULL LIMIT 3')
      step2 = test2.rows.map(r => ({ id: r.id, ts: r.ts }))
    }
    const pgDb = require('./core/pg_database')
    const step3 = await pgDb.getMatchesByStatuses(['scheduled'])
    res.json({ step1, step2, step3_count: step3.length, step3_sample: step3.slice(0, 2).map(r => ({ id: r.id, homeTeam: r.homeTeam, startTs: r.startTimestamp })) })
  } catch (e) {
    res.json({ error: e.message, stack: (e.stack || '').slice(0, 500) })
  }
})

app.get('/api/audit/performance', async (req, res) => {
  try {
    const auditService = require('./services/auditService');
    res.json(await auditService.getPerformanceSnapshot());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/predict', async (req, res) => {
  try {
    const match = req.body;
    const enrichedPredictions = require('./core/enriched_predictions');
    const result = await enrichedPredictions.enrichMatch(match);
    res.json(result);
  } catch (err) {
    logger.error('❌ [API-PREDICT] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/config', securityEngine.authenticate.bind(securityEngine), async (req, res) => {
  try {
    const newConfig = req.body;
    const ALLOWED_KEYS = ['scraperUrl', 'SOURCE_MODE', 'thresholds', 'autoPurge', 'strategy'];
    
    for (const key of Object.keys(newConfig)) {
      if (ALLOWED_KEYS.includes(key)) configEngine.config[key] = newConfig[key];
    }

    if (newConfig.botToken) await configEngine.updateEnv('TELEGRAM_BOT_TOKEN', newConfig.botToken);
    if (newConfig.chatId) await configEngine.updateEnv('TELEGRAM_CHAT_ID', newConfig.chatId);

    await configEngine.save();
    res.json({ success: true, activeConfig: configEngine.config });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/props/today', async (req, res) => {
  try { 
    res.json({ success: true, props: playerPropsService.getBestPropsToday(30) }); 
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/patterns', async (req, res) => {
  try {
    const db = require('./core/database');
    const results = await db.getAllPatterns(100);
    res.json(results);
  } catch (e) { res.status(500).json({ error: 'Archive inaccessible' }); }
});

// ── MOUNT MODULAR ROUTERS ─────────────────
app.use('/api/learn', learnRoutes);
app.use('/api/combos', comboRoutes);
app.use('/api', systemRoutes);
app.use('/api', analyticsRoutes);
app.use('/api/evolution', evolutionRoutes);
app.use('/api', scraperRoutes);
app.use('/api', matchesRoutes);
app.use('/api/promosport', promosportRoutes);
app.use('/api/ds', dsRoutes);
app.use('/api/webhook', securityEngine.authenticate.bind(securityEngine), integrationRoutes);

// ── GLOBAL ERROR HANDLER ──────────────────
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  
  // Log more details about the error
  logger.error(`💥 [GLOBAL ERROR] ${req.method} ${req.url} - Status: ${status}`, err);
  
  if (res.headersSent) {
    return next(err);
  }

  res.status(status).json({
    error: 'Internal Server Error',
    message: err.message,
    path: req.url,
    timestamp: new Date().toISOString()
  });
});

// 🤖 AUTO-HEAL ENDPOINTS
app.get('/api/autoheal/status', (req, res) => {
  res.json(autoHealAgent.getStatus())
})

app.post('/api/autoheal/patrol', async (req, res) => {
  try {
    const result = await autoHealAgent.triggerPatrol()
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/autoheal/history', (req, res) => {
  const remedies = require('./services/autoHealRemedies')
  res.json({ history: remedies.getHistory() })
})

app.get('/api/fallback/status', (req, res) => {
  res.json(apiFallbackManager.getAllStatus())
})

app.get('/api/leagues', async (req, res) => {
  try { res.json(await database.getAllLeaguesConfig()); } catch (error) { res.status(500).json({ error: error.message }); }
});

const publicPath = path.normalize(path.join(__dirname, 'dist'));
// Serve static assets with cache, but never cache HTML files
app.use(express.static(publicPath, {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year for js/css/images
    }
  }
}));

// Fallback for React Router (SPA)
app.get(/^(?!\/api|\/socket\.io).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(publicPath, 'index.html'), (err) => {
    if (err && !res.headersSent) {
      res.status(404).send("Not Found");
    }
  });
});

const server = http.createServer(app);

// ⚡ Socket.io & Real-time Synchronization
socketService.init(server);

// 🔴 Live Match Polling (every 30s)
const liveMatchService = require('./services/liveMatchService');
liveMatchService.startPolling(30000);

// 🧠 ML Prediction Service Bridge
const getMLPrediction = (match) => mlPredictionService.getMLPrediction(match);

// ── SERVER STARTUP & LIFECYCLE ─────────
(async () => {
  try {
    const { exec } = require('child_process');
    const killProcessOnPort = (port) => new Promise((resolve) => {
      if (process.platform !== 'win32') return resolve();
      const cmd = `netstat -ano | findstr LISTENING | findstr :${port}`;
      exec(cmd, (err, stdout) => {
        if (err || !stdout) return resolve();
        const lines = stdout.trim().split(/\r?\n/);
        const pidsToKill = new Set();
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== '0' && parseInt(pid) !== process.pid && /^\d+$/.test(pid)) {
            pidsToKill.add(pid);
          }
        }
        if (pidsToKill.size === 0) return resolve();
        logger.warn(`⚠️  Port ${port} occupied by PID(s) [${[...pidsToKill].join(', ')}]. Releasing...`);
        const kills = [...pidsToKill].map(pid => new Promise(r => exec(`taskkill /F /PID ${pid} /T`, () => r())));
        Promise.all(kills).then(() => setTimeout(resolve, 1200));
      });
    });

    await killProcessOnPort(PORT);
    await new Promise(resolve => setTimeout(resolve, 500)); // Small grace period

    try {
      const { redis } = require('./core/redisClient');
      if (redis) {
        redis.ping()
          .then(() => console.log('✅ [STARTUP] Redis connection confirmed.'))
          .catch(() => console.warn('⚠️ [STARTUP] Redis not reachable. Caching will degrade to fallback.'));
      }
    } catch (redisErr) {
      console.warn('⚠️ [STARTUP] Redis client check failed.');
    }

    const startServer = (retries = 5) => {
      server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Titanium Server listening at http://127.0.0.1:${PORT}`);
        logger.info('✅ API GATEWAY ACTIVE');

        setTimeout(async () => {
          try {
            // 🔍 [DIAGNOSTIC] Log which API keys are missing at startup
            const requiredKeys = [
              ['BSD_API_KEY', 'BSD Bzzoiro'],
              ['ODDSPAPI_KEY', 'OddsPapi'],
              ['FOOTBALLDATA_KEY', 'FootballData.io'],
              ['RAPIDAPI_KEY', 'RapidAPI SportAPI'],
              ['THERUNDOWN_KEY', 'TheRundown'],
              ['SPORTMONKS_KEY', 'Sportmonks'],
              ['APIFOOTBALL_KEY', 'APIFootball'],
              ['SUPABASE_URL', 'Neon PostgreSQL'],
              ['INFERENCE_URL', 'Python FastAPI'],
              ['PREDIXSPORT_API_KEY', 'PredixSport API'],
              ['BBS_API_KEY', 'Big Balls Data'],
              ['ODDSAPI_IO_KEY', 'Odds-API.io'],
              ['GROQ_API_KEY', 'Groq AI'],
              ['GEMINI_API_KEY', 'Gemini AI'],
            ]
            const missing = requiredKeys.filter(([key]) => !process.env[key] || process.env[key].startsWith('CHANGER_MOI'))
            if (missing.length > 0) {
              console.log('🔍 [DIAGNOSTIC] API keys manquantes sur Render Dashboard:')
              missing.forEach(([, name]) => console.log(`   ❌ ${name}`))
              console.log('   → Allez sur https://dashboard.render.com → Environment → ajoutez ces clés')
            } else {
              console.log('✅ [DIAGNOSTIC] Toutes les clés API sont configurées')
            }

            if (process.env.DISABLE_BACKUP !== 'true') backupService.startAutomatedBackups();
            botService.startPolling();
            
            await redisCache.init().catch(e => logger.warn('Redis error:', e.message));
            
            cronManager.init(socketService);
            
            await retroSync.syncPastMatches().catch(() => {});
            clvService.start().catch(() => {});
            logger.info('🧠 [AI] Background enrichment logic active');

            // 🗄️ [SUPABASE] PostgreSQL cloud persistence — dual-sync startup
            setTimeout(async () => {
              try {
                const connected = await supabaseService.connect()
                if (connected) {
                  await supabaseService.initSchema()
                  // Phase 1: restore cloud data → SQLite (survives redeploy)
                  await supabaseService.restoreToSQLite(database)
                  // Phase 2: push latest SQLite data → cloud
                  await supabaseService.syncFromSQLite(database)
                  // Phase 3: continuous sync every 5 min
                  supabaseService.startPeriodicSync(database)
                  logger.info('✅ [SUPABASE] Dual-sync active — data survives redeploys')
                }
              } catch (e) {
                logger.warn(`⚠️ [SUPABASE] Init error: ${e.message}`)
              }
            }, 5000)

            // 🧹 Clean up any matches with placeholder team names
            database.cleanupPlaceholderTeams()
            // Also try to clean the cloud
            setTimeout(() => {
              try { supabaseService.cleanupPlaceholderTeams() } catch (_) {}
            }, 15000)

            // 🌱 [CLOUD-SEED] Auto-populate DB on fresh Render deployment (no Puppeteer needed)
            try {
              const { runCloudSeed } = require('./core/cloudSeed');
              runCloudSeed().then(() => {
                // Clean up any placeholder matches that might have been inserted
                database.cleanupPlaceholderTeams()
              }).catch(e => logger.warn('⚠️ [CLOUD-SEED] Error:', e.message));
            } catch (seedErr) {
              logger.warn('⚠️ [CLOUD-SEED] Module load failed:', seedErr.message);
            }

            // 🔁 [FALLBACK] Register API sources at startup
            try {
              apiFallbackManager.registerSource({
                name: 'BSD',
                priority: 1,
                isAvailable: () => bsdService.isAvailable(),
                getQuotaStatus: () => ({ available: bsdService.isAvailable() })
              })
              apiFallbackManager.registerSource({
                name: 'TheRundown',
                priority: 2,
                isAvailable: () => therundownService.isAvailable(),
                getQuotaStatus: () => therundownService.getQuotaStatus()
              })
              apiFallbackManager.registerSource({
                name: 'OddsPapi',
                priority: 3,
                isAvailable: () => oddspapiService.isAvailable(),
                getQuotaStatus: () => oddspapiService.getQuotaStatus()
              })
              apiFallbackManager.registerSource({
                name: 'Sportmonks',
                priority: 4,
                isAvailable: () => sportmonksService.isAvailable(),
                getQuotaStatus: () => sportmonksService.getQuotaStatus()
              })
              apiFallbackManager.registerSource({
                name: 'APIFootball',
                priority: 5,
                isAvailable: () => apifootballService.isAvailable(),
                getQuotaStatus: () => apifootballService.getQuotaStatus()
              })
              apiFallbackManager.registerSource({
                name: 'OpenLigaDB',
                priority: 6,
                isAvailable: () => openligadbService.isAvailable(),
                getQuotaStatus: () => ({ available: openligadbService.isAvailable() }),
                fetchEvents: (dateStr) => openligadbService.fetchEvents(dateStr)
              })
              apiFallbackManager.registerSource({
                name: 'PredixSport',
                priority: 7,
                isAvailable: () => predixSportService.isAvailable(),
                getQuotaStatus: () => ({ available: predixSportService.isAvailable() })
              })
              apiFallbackManager.registerSource({
                name: 'BigBallsData',
                priority: 8,
                isAvailable: () => bigBallsDataService.isAvailable(),
                getQuotaStatus: () => ({ available: bigBallsDataService.isAvailable() })
              })
              apiFallbackManager.registerSource({
                name: 'OddsAPIio',
                priority: 9,
                isAvailable: () => oddsApiIoService.isAvailable(),
                getQuotaStatus: () => ({ available: oddsApiIoService.isAvailable() })
              })
              logger.info('🔁 [FALLBACK] API sources registered (BSD → TheRundown → OddsPapi → Sportmonks → APIFootball → OpenLigaDB → PredixSport → BigBallsData → OddsAPIio)')
            } catch (fbErr) {
              logger.warn('⚠️ [FALLBACK] Registration error:', fbErr.message)
            }

            // 🤖 [AUTOHEAL] Run initial patrol 30 seconds after startup
            setTimeout(() => {
              autoHealAgent.patrol().catch(e => logger.warn('⚠️ [AUTOHEAL] Initial patrol error:', e.message))
            }, 30000)
          } catch (initErr) {
            logger.error('💥 [CRITICAL] Service Initialization Error:', initErr.message);
          }
        }, 500);
      }).on('error', async (err) => {
        if (err.code === 'EADDRINUSE') {
          if (retries > 0) {
            logger.warn(`⚠️  Port ${PORT} in use, retrying in 2s... (${retries} retries left)`);
            await killProcessOnPort(PORT);
            setTimeout(() => startServer(retries - 1), 2000);
          } else {
            logger.error(`💥 [FATAL] Port ${PORT} is persistently occupied. Manual intervention required.`);
            process.exit(1);
          }
        } else {
          logger.error(`💥 [FATAL] Server Error: ${err.message}`);
          process.exit(1);
        }
      });
    };

    startServer();

  } catch (e) {
    console.error('💥 FATAL STARTUP ERROR:', e);
    process.exit(1);
  }
})();

process.on('uncaughtException', (err) => {
  logger.error(`💥 [FATAL] Uncaught Exception: ${err.message}`, { stack: err.stack });
  setTimeout(() => process.exit(1), 1000); // Give logger time to flush
});

process.on('unhandledRejection', (reason) => {
  logger.error('⚠️  UNHANDLED REJECTION:', reason instanceof Error ? reason.message : String(reason));
});

const shutDown = () => {
  logger.info('🛑 Received kill signal, shutting down gracefully');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
};

process.on('SIGTERM', shutDown);
process.on('SIGINT', shutDown);
