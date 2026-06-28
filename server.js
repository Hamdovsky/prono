if (process.env.NODE_ENV !== 'production') { require('dotenv').config(); }

const app = require('./app')

const http = require('http')
const fs = require('fs')
const path = require('path')
const logger = require('./core/logger')
const database = require('./core/database')
const socketService = require('./services/socketService')
const mlPredictionService = require('./services/mlPredictionService')
const cronManager = require('./services/cronManager')
const backupService = require('./backup_service')
const botService = require('./services/botService')
const supabaseService = require('./services/supabaseService')
const apiFallbackManager = require('./services/apiFallbackManager')
const bsdService = require('./services/bsdService')
const therundownService = require('./services/therundownService')
const oddspapiService = require('./services/oddspapiService')
const openligadbService = require('./services/openligadbService')
const sportmonksService = require('./services/sportmonksService')
const apifootballService = require('./services/apifootballService')
const bigBallsDataService = require('./services/bigBallsDataService')
const oddsApiIoService = require('./services/oddsApiIoService')
const predixSportService = require('./services/predixSportService')
const futpythonService = require('./services/futpythonService')
const clearSportsService = require('./services/clearSportsService')
const sportApiService = require('./services/sportApiService')
const apiNinjasService = require('./services/apiNinjasService')
const autoHealAgent = require('./services/autoHealAgent')
const retroSync = require('./services/retroSyncService')
const clvService = require('./services/clvService')
const _redisClient = require('./core/redisClient')

const redisCache = {
  get: _redisClient.getCache,
  set: (key, value, ttl) => _redisClient.setCache(key, value, ttl),
  init: () => Promise.resolve(),
  ..._redisClient
}

const PORT = process.env.PORT || 3001

console.log('🚀 [STARTUP] INITIALIZING TITANIUM SERVER V3.0...')

const server = http.createServer(app)

// ⚡ Socket.io & Real-time Synchronization
socketService.init(server)

// 🧠 ML Prediction Service Bridge
const getMLPrediction = (match) => mlPredictionService.getMLPrediction(match)

// ── SERVER STARTUP & LIFECYCLE ─────────
;(async () => {
  try {
    const { exec } = require('child_process')
    const killProcessOnPort = (port) => new Promise((resolve) => {
      const cmd = process.platform === 'win32'
        ? `netstat -ano | findstr LISTENING | findstr :${port}`
        : `lsof -ti :${port} 2>/dev/null`
      exec(cmd, (err, stdout) => {
        if (err || !stdout) return resolve()
        const pids = stdout.trim().split(/\r?\n/).filter(Boolean)
        if (pids.length === 0) return resolve()
        logger.warn(`⚠️  Port ${port} occupied by PID(s) [${pids.join(', ')}]. Releasing...`)
        const kills = pids.map(pid => new Promise(r => exec(
          process.platform === 'win32' ? `taskkill /F /PID ${pid} /T` : `kill -9 ${pid}`,
          () => r()
        )))
        Promise.all(kills).then(() => setTimeout(resolve, 1200))
      })
    })

    await killProcessOnPort(PORT)
    await new Promise(resolve => setTimeout(resolve, 500)) // Small grace period

    try {
      const { redis } = require('./core/redisClient')
      if (redis) {
        redis.ping()
          .then(() => console.log('✅ [STARTUP] Redis connection confirmed.'))
          .catch(() => console.warn('⚠️ [STARTUP] Redis not reachable. Caching will degrade to fallback.'))
      }
    } catch (redisErr) {
      console.warn('⚠️ [STARTUP] Redis client check failed.')
    }

    // Download historical archive if missing (Render ephemeral fs)
    const archivePath = path.join(__dirname, 'data', 'historical_archive.sqlite')
    if (!fs.existsSync(archivePath)) {
      const ARCHIVE_URL = process.env.ARCHIVE_DOWNLOAD_URL || ''
      if (ARCHIVE_URL) {
        console.log('[STARTUP] historical_archive.sqlite missing — downloading...')
        ;(async () => {
          try {
            const https = require('https')
            const zlib = require('zlib')
            const tmp = archivePath + '.download'
            await new Promise((resolve, reject) => {
              const file = fs.createWriteStream(tmp)
              https.get(ARCHIVE_URL, res => {
                if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return }
                const gunzip = zlib.createGunzip()
                res.pipe(gunzip).pipe(file)
                file.on('finish', () => { file.close(); resolve() })
              }).on('error', reject)
            })
            fs.renameSync(tmp, archivePath)
            console.log(`[STARTUP] Archive downloaded (${(fs.statSync(archivePath).size / 1024 / 1024).toFixed(1)} MB)`)
          } catch (e) {
            console.warn(`[STARTUP] Archive download failed: ${e.message}`)
            if (fs.existsSync(archivePath + '.download')) fs.unlinkSync(archivePath + '.download')
          }
        })()
      } else {
        console.log('[STARTUP] ARCHIVE_DOWNLOAD_URL not set — skipping archive download')
      }
    } else {
      console.log(`[STARTUP] Archive found locally (${(fs.statSync(archivePath).size / 1024 / 1024).toFixed(1)} MB)`)
    }

    // Download premium CSV if missing (Render ephemeral fs)
    const premiumCsvPath = path.join(__dirname, 'data', 'v553_wc2026_premium.csv')
    if (!fs.existsSync(premiumCsvPath)) {
      const PREMIUM_CSV_URL = process.env.PREMIUM_CSV_URL || ''
      if (PREMIUM_CSV_URL) {
        console.log('[STARTUP] v553_wc2026_premium.csv missing — downloading...')
        ;(async () => {
          try {
            const https = require('https')
            const tmp = premiumCsvPath + '.download'
            await new Promise((resolve, reject) => {
              const file = fs.createWriteStream(tmp)
              https.get(PREMIUM_CSV_URL, res => {
                if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return }
                res.pipe(file)
                file.on('finish', () => { file.close(); resolve() })
              }).on('error', reject)
            })
            fs.renameSync(tmp, premiumCsvPath)
            console.log(`[STARTUP] Premium CSV downloaded (${(fs.statSync(premiumCsvPath).size / 1024 / 1024).toFixed(1)} MB)`)
          } catch (e) {
            console.warn(`[STARTUP] Premium CSV download failed: ${e.message}`)
            if (fs.existsSync(premiumCsvPath + '.download')) fs.unlinkSync(premiumCsvPath + '.download')
          }
        })()
      } else {
        console.log('[STARTUP] PREMIUM_CSV_URL not set — skipping premium CSV download')
      }
    } else {
      console.log(`[STARTUP] Premium CSV found locally (${(fs.statSync(premiumCsvPath).size / 1024 / 1024).toFixed(1)} MB)`)
    }

    // Bootstrap: fetch fixtures + stats from working APIs at startup
    setTimeout(async () => {
      try {
        const bsd = require('./services/bsdService')
        if (bsd.isAvailable()) {
          console.log('[STARTUP] BSD API available — syncing fixtures...')
          await bsd.fullSync().then(n => console.log(`[STARTUP] BSD sync complete: ${n} matches`))
        }
      } catch (e) {
        console.warn(`[STARTUP] BSD sync skipped: ${e.message}`)
      }

      // Fetch WC2026 match data from Football-Data.org (has real scores + standings)
      try {
        const fdKey = process.env.FOOTBALLDATA_KEY || ''
        if (fdKey && !fdKey.startsWith('CHANGER_MOI')) {
          const https = require('https')
          const db = require('./core/database')
          const today = new Date().toISOString().split('T')[0]
          const url = `https://api.football-data.org/v4/competitions/WC/matches?dateFrom=${today}&dateTo=${today}`
          console.log('[STARTUP] Fetching WC2026 data from Football-Data.org...')
          const body = await new Promise((resolve, reject) => {
            https.get(url, { headers: { 'X-Auth-Token': fdKey } }, res => {
              let d = ''
              res.on('data', c => d += c)
              res.on('end', () => resolve(d))
            }).on('error', reject)
          })
          const data = JSON.parse(body)
          const matches = data.matches || []
          console.log(`[STARTUP] Football-Data: ${matches.length} WC2026 matches today`)
          for (const m of matches) {
            const home = m.homeTeam.name
            const away = m.awayTeam.name
            const score = m.score?.fullTime || {}
            const status = m.status
            // Store in match fullData for prediction engine to use
            try {
              const existing = db.db?.prepare("SELECT id, fullData FROM matches WHERE homeTeam = ? AND awayTeam = ? AND DATE(timestamp) = ? LIMIT 1")
                .get(home, away, today)
              if (existing) {
                const fd = JSON.parse(existing.fullData || '{}')
                fd.footballData = { score, status, competition: 'WC', matchId: m.id }
                db.db?.prepare("UPDATE matches SET fullData = ? WHERE id = ?")
                  .run(JSON.stringify(fd), existing.id)
              }
            } catch (_) {}
          }
          console.log('[STARTUP] Football-Data sync done')
        }
      } catch (e) {
        console.warn(`[STARTUP] Football-Data sync failed: ${e.message}`)
      }
    }, 5000)

    const startServer = (retries = 5) => {
      console.log(`[PORT] Attempting to bind to PORT=${PORT} on 0.0.0.0 (retries left: ${retries})`)
      server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Titanium Server listening at http://0.0.0.0:${PORT}`);
        logger.info('✅ API GATEWAY ACTIVE');

        setTimeout(async () => {
          try {
            // 🔍 [DIAGNOSTIC] Log which API keys are missing at startup
            if (!process.env.LOCAL_DATA_URL) {
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
                ['FUTPYTHONTRADER_API_KEY', 'FutPythonTrader'],
              ]
              const missing = requiredKeys.filter(([key]) => !process.env[key] || process.env[key].startsWith('CHANGER_MOI'))
              if (missing.length > 0) {
                console.log('🔍 [DIAGNOSTIC] API keys manquantes sur Render Dashboard:')
                missing.forEach(([, name]) => console.log(`   ❌ ${name}`))
                console.log('   → Allez sur https://dashboard.render.com → Environment → ajoutez ces clés')
              } else {
                console.log('✅ [DIAGNOSTIC] Toutes les clés API sont configurées')
              }
            } else {
              console.log('🔍 [DIAGNOSTIC] LOCAL_DATA_URL actif — API keys ignorées, tout passe par ngrok')
            }

            if (process.env.DISABLE_BACKUP !== 'true') backupService.startAutomatedBackups();
            if (process.env.TELEGRAM_BOT_TOKEN) {
              botService.startPolling();
            } else {
              logger.warn('⚠️ [STARTUP] TELEGRAM_BOT_TOKEN not set — bot polling disabled');
            }
            
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
              runCloudSeed().then(async () => {
                // Clean up any placeholder matches that might have been inserted
                database.cleanupPlaceholderTeams()
                // 🔄 Auto-enrich matches after seeding
                try {
                  const enrichedPredictions = require('./core/enriched_predictions');
                  const matches = await database.getMatchesByStatus('scheduled');
                  if (matches.length > 0) {
                    logger.info(`📡 [AUTO-ENRICH] Enriching ${matches.length} matches after cloud seed...`);
                    const enriched = await enrichedPredictions.enrichMatches(matches, { fastMode: true, force: true });
                    let updated = 0;
                    for (const m of enriched) {
                      if (m.expected_score && m.expected_score !== 'N/A') {
                        await database.updatePredictions(m.id, m);
                        updated++;
                      }
                    }
                    logger.info(`✅ [AUTO-ENRICH] Updated ${updated}/${matches.length} matches`);
                  }
                } catch (enrichErr) {
                  logger.warn(`⚠️ [AUTO-ENRICH] Error: ${enrichErr.message}`);
                }
              }).catch(e => logger.warn('⚠️ [CLOUD-SEED] Error:', e.message));
            } catch (seedErr) {
              logger.warn('⚠️ [CLOUD-SEED] Module load failed:', seedErr.message);
            }

            // 🌱 [EMERGENCY SEED] If DB still has < 10 matches, seed with demo data
            (async () => {
              try {
                const count = await database.query('SELECT COUNT(*) as cnt FROM matches')
                const matchCount = count?.rows?.[0]?.cnt || 0
                if (matchCount < 10) {
                  logger.info(`[EMERGENCY-SEED] DB has ${matchCount} matches — seeding emergency data...`)
                  const { seedDemoMatches } = require('./scripts/seed_emergency')
                  const seeded = await seedDemoMatches(database)
                  logger.info(`[EMERGENCY-SEED] Seeded ${seeded} demo matches`)
                } else {
                  logger.info(`[EMERGENCY-SEED] DB has ${matchCount} matches — skipping`)
                }
              } catch (e) {
                logger.warn(`[EMERGENCY-SEED] Error: ${e.message}`)
              }
            })()

            // 🔁 [FALLBACK] Register API sources at startup
            const localDataUrl = process.env.LOCAL_DATA_URL || ''
            if (localDataUrl) {
              logger.info('[FALLBACK] LOCAL_DATA_URL detected — external API sources SKIPPED. Using ngrok tunnel only.')
            } else {
              try {
                apiFallbackManager.registerSource({
                  name: 'BSD',
                  priority: 1,
                  isAvailable: () => bsdService.isAvailable(),
                  getQuotaStatus: () => ({ available: bsdService.isAvailable() }),
                  fetchEvents: (dateStr) => bsdService.fetchEvents(dateStr),
                  fetchOdds: (matchId) => bsdService.fetchOdds(matchId),
                  fetchPredictions: (matchId) => bsdService.fetchPredictions(matchId),
                  fetchLiveEvents: () => bsdService.fetchLiveEvents()
                })
                apiFallbackManager.registerSource({
                  name: 'TheRundown',
                  priority: 2,
                  isAvailable: () => therundownService.isAvailable(),
                  getQuotaStatus: () => therundownService.getQuotaStatus(),
                  fetchEvents: (dateStr) => therundownService.fetchSoccerEvents(dateStr),
                  fetchOdds: (eventId) => therundownService.fetchOddsForMatch(eventId)
                })
                apiFallbackManager.registerSource({
                  name: 'OddsPapi',
                  priority: 3,
                  isAvailable: () => oddspapiService.isAvailable(),
                  getQuotaStatus: () => oddspapiService.getQuotaStatus(),
                  fetchEvents: (dateStr) => oddspapiService.fetchEvents(dateStr),
                  fetchOdds: (fixtureId) => oddspapiService.fetchOddsForFixture(fixtureId)
                })
                apiFallbackManager.registerSource({
                  name: 'Sportmonks',
                  priority: 4,
                  isAvailable: () => sportmonksService.isAvailable(),
                  getQuotaStatus: () => sportmonksService.getQuotaStatus(),
                  fetchEvents: (dateStr) => sportmonksService.fetchEvents(dateStr),
                  fetchOdds: (fixtureId) => sportmonksService.fetchPrematchOdds(fixtureId)
                })
                apiFallbackManager.registerSource({
                  name: 'APIFootball',
                  priority: 5,
                  isAvailable: () => apifootballService.isAvailable(),
                  getQuotaStatus: () => apifootballService.getQuotaStatus(),
                  fetchEvents: (dateStr) => apifootballService.fetchEvents(dateStr),
                  fetchOdds: (fixtureId) => apifootballService.fetchOdds(fixtureId),
                  fetchPredictions: (fixtureId) => apifootballService.fetchPredictions(fixtureId)
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
                  getQuotaStatus: () => ({ available: predixSportService.isAvailable() }),
                  fetchEvents: () => predixSportService.fetchUpcoming()
                })
                apiFallbackManager.registerSource({
                  name: 'BigBallsData',
                  priority: 8,
                  isAvailable: () => bigBallsDataService.isAvailable(),
                  getQuotaStatus: () => ({ available: bigBallsDataService.isAvailable() }),
                  fetchEvents: (league, status) => bigBallsDataService.getMatches(league, status)
                })
                apiFallbackManager.registerSource({
                  name: 'OddsAPIio',
                  priority: 9,
                  isAvailable: () => oddsApiIoService.isAvailable(),
                  getQuotaStatus: () => ({ available: oddsApiIoService.isAvailable() }),
                  fetchEvents: (sport, status, limit) => oddsApiIoService.getEvents(sport, status, limit)
                })
                apiFallbackManager.registerSource({
                  name: 'FutPythonTrader',
                  priority: 10,
                  isAvailable: () => futpythonService.isAvailable(),
                  getQuotaStatus: () => ({ available: futpythonService.isAvailable() }),
                  fetchEvents: (source, params) => futpythonService.getMatches(source, params)
                })
                apiFallbackManager.registerSource({
                  name: 'ClearSports',
                  priority: 11,
                  isAvailable: () => clearSportsService.isAvailable(),
                  getQuotaStatus: () => ({ available: clearSportsService.isAvailable() }),
                  fetchEvents: (dateStr) => clearSportsService.fetchEvents(dateStr),
                  fetchOdds: (gameKey) => clearSportsService.fetchOdds(gameKey),
                  fetchLiveEvents: () => clearSportsService.fetchLiveEvents()
                })
                apiFallbackManager.registerSource({
                  name: 'SportAPI',
                  priority: 12,
                  isAvailable: () => sportApiService.isAvailable(),
                  getQuotaStatus: () => ({ available: sportApiService.isAvailable() }),
                  fetchEvents: (dateStr) => sportApiService.fetchEvents(dateStr),
                  fetchOdds: (fixtureId) => sportApiService.fetchOdds(fixtureId),
                  fetchLiveEvents: () => sportApiService.fetchLiveEvents()
                })
                apiFallbackManager.registerSource({
                  name: 'APINinjas',
                  priority: 13,
                  isAvailable: () => apiNinjasService.isAvailable(),
                  getQuotaStatus: () => ({ available: apiNinjasService.isAvailable() }),
                  fetchEvents: (dateStr) => apiNinjasService.fetchEvents(dateStr),
                  fetchLiveEvents: () => apiNinjasService.fetchLiveEvents()
                })
                logger.info('🔁 [FALLBACK] API sources registered (BSD → TheRundown → OddsPapi → Sportmonks → APIFootball → OpenLigaDB → PredixSport → BigBallsData → OddsAPIio → FutPythonTrader → ClearSports → SportAPI → APINinjas)')
              } catch (fbErr) {
                logger.warn('⚠️ [FALLBACK] Registration error:', fbErr.message)
              }
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
        console.log(`[PORT] Error binding: ${err.code} - ${err.message}`)
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
    console.error('💥 FATAL STARTUP ERROR:', e.message);
    // Still try to start server even if init failed
    try { startServer(); } catch (e2) {
      console.error('💥 FATAL startServer error:', e2.message);
      process.exit(1);
    }
  }
})();

process.on('uncaughtException', (err) => {
  const msg = `💥 [FATAL] Uncaught Exception: ${err.message}`
  try { logger.error(msg, { stack: err.stack }) } catch (_) { console.error(msg) }
  setTimeout(() => process.exit(1), 1000)
})

process.on('unhandledRejection', (reason) => {
  const msg = `⚠️  UNHANDLED REJECTION: ${reason instanceof Error ? reason.message : String(reason)}`
  try { logger.error(msg) } catch (_) { console.error(msg) }
})

const shutDown = () => {
  logger.info('🛑 Received kill signal, shutting down gracefully');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
};

process.on('SIGTERM', shutDown);
process.on('SIGINT', shutDown);
