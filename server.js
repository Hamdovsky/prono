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
const archiveService = require('./services/archiveService');
const patternService = require('./services/patternService');
const socketService = require('./services/socketService');
const cronManager = require('./services/cronManager');

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

console.log('🚀 [STARTUP] INITIALIZING TITANIUM SERVER V3.0...');

const app = express();

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

// CORS - restrict in production
const corsOptions = {
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
};
app.use(cors(corsOptions));

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
app.use('/api', securityEngine.middleware.bind(securityEngine), matchesRoutes);
app.use('/api/promosport', promosportRoutes);
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
            if (process.env.DISABLE_BACKUP !== 'true') backupService.startAutomatedBackups();
            botService.startPolling();
            
            await redisCache.init().catch(e => logger.warn('Redis error:', e.message));
            
            cronManager.init(socketService);
            
            await retroSync.syncPastMatches().catch(() => {});
            clvService.start().catch(() => {});
            logger.info('🧠 [AI] Background enrichment logic active');

            // 🌱 [CLOUD-SEED] Auto-populate DB on fresh Render deployment (no Puppeteer needed)
            try {
              const { runCloudSeed } = require('./core/cloudSeed');
              runCloudSeed().catch(e => logger.warn('⚠️ [CLOUD-SEED] Error:', e.message));
            } catch (seedErr) {
              logger.warn('⚠️ [CLOUD-SEED] Module load failed:', seedErr.message);
            }
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
