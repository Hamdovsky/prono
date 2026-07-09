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

logger.info(`🚀 [STARTUP] INITIALIZING TITANIUM SERVER V3.0... PORT=${PORT}`)

const server = http.createServer(app)

// ⚡ Socket.io & Real-time Synchronization
socketService.init(server)

// 🧠 ML Prediction Service Bridge
const getMLPrediction = (match) => mlPredictionService.getMLPrediction(match)

// ── SERVER STARTUP & LIFECYCLE ─────────
;(async () => {
  logger.info('🔍 [DEBUG] IIFE started')
  try {
    const { exec } = require('child_process')
    const killProcessOnPort = (port) => new Promise((resolve) => {
      if (process.platform !== 'win32') return resolve()
      exec(`netstat -ano | findstr LISTENING | findstr :${port}`, (err, stdout) => {
        if (err || !stdout) return resolve()
        const lines = stdout.trim().split(/\r?\n/)
        const pidsToKill = new Set()
        for (const line of lines) {
          const parts = line.trim().split(/\s+/)
          const pid = parts[parts.length - 1]
          if (pid && pid !== '0' && parseInt(pid) !== process.pid && /^\d+$/.test(pid)) {
            pidsToKill.add(pid)
          }
        }
        if (pidsToKill.size === 0) return resolve()
        logger.warn(`⚠️  Port ${port} occupied by PID(s) [${[...pidsToKill].join(', ')}]. Releasing...`)
        const kills = [...pidsToKill].map(pid => new Promise(r => exec(`taskkill /F /PID ${pid} /T`, () => r())))
        Promise.all(kills).then(() => setTimeout(resolve, 1200))
      })
    })

    await killProcessOnPort(PORT)
    await new Promise(resolve => setTimeout(resolve, 500)) // Small grace period
    logger.info('🔍 [DEBUG] IIFE past grace period')

    try {
      const { redis } = require('./core/redisClient')
      if (redis) {
        redis.ping()
          .then(() => logger.info('✅ [STARTUP] Redis connection confirmed.'))
          .catch(() => logger.warn('⚠️ [STARTUP] Redis not reachable. Caching will degrade to fallback.'))
      }
    } catch (redisErr) {
      logger.warn('⚠️ [STARTUP] Redis client check failed.')
    }

    // Download historical archive if missing (Render ephemeral fs)
    const archivePath = path.join(__dirname, 'data', 'historical_archive.sqlite')
    if (!fs.existsSync(archivePath)) {
      const ARCHIVE_URL = process.env.ARCHIVE_DOWNLOAD_URL || ''
      if (ARCHIVE_URL) {
        logger.info('[STARTUP] historical_archive.sqlite missing — downloading...')
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
            logger.info(`[STARTUP] Archive downloaded (${(fs.statSync(archivePath).size / 1024 / 1024).toFixed(1)} MB)`)
          } catch (e) {
            logger.warn(`[STARTUP] Archive download failed: ${e.message}`)
            if (fs.existsSync(archivePath + '.download')) fs.unlinkSync(archivePath + '.download')
          }
        })()
      } else {
        logger.info('[STARTUP] ARCHIVE_DOWNLOAD_URL not set — skipping archive download')
      }
    } else {
      logger.info(`[STARTUP] Archive found locally (${(fs.statSync(archivePath).size / 1024 / 1024).toFixed(1)} MB)`)
    }

    // Import promosport archive from JSON files (async, non-blocking)
    setTimeout(() => {
      const importScript = path.join(__dirname, 'scripts', 'import_promosport_archive.py')
      if (fs.existsSync(importScript)) {
        const { spawn } = require('child_process')
        const py = spawn('python3', [importScript], { cwd: __dirname, stdio: 'ignore', timeout: 120000 })
        py.on('close', code => {
          if (code === 0) logger.info('[STARTUP] Promosport archive import OK')
          else logger.warn(`[STARTUP] Promosport archive import exited ${code}`)
        })
      }
    }, 5000)

    // Download premium CSV if missing (Render ephemeral fs)
    const premiumCsvPath = path.join(__dirname, 'data', 'v553_wc2026_premium.csv')
    if (!fs.existsSync(premiumCsvPath)) {
      const PREMIUM_CSV_URL = process.env.PREMIUM_CSV_URL || ''
      if (PREMIUM_CSV_URL) {
        logger.info('[STARTUP] v553_wc2026_premium.csv missing — downloading...')
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
            logger.info(`[STARTUP] Premium CSV downloaded (${(fs.statSync(premiumCsvPath).size / 1024 / 1024).toFixed(1)} MB)`)
          } catch (e) {
            logger.warn(`[STARTUP] Premium CSV download failed: ${e.message}`)
            if (fs.existsSync(premiumCsvPath + '.download')) fs.unlinkSync(premiumCsvPath + '.download')
          }
        })()
      } else {
        logger.info('[STARTUP] PREMIUM_CSV_URL not set — skipping premium CSV download')
      }
    } else {
      logger.info(`[STARTUP] Premium CSV found locally (${(fs.statSync(premiumCsvPath).size / 1024 / 1024).toFixed(1)} MB)`)
    }

    // Warm theta optimizer + league calibrator from Neon archive
    setTimeout(async () => {
      try {
        const thetaOptimizer = require('./services/thetaOptimizer')
        await thetaOptimizer.optimize()
        logger.info('[STARTUP] Theta optimizer calibrated from Neon archive')
      } catch (e) {
        logger.warn(`[STARTUP] Theta init: ${e.message}`)
      }
      try {
        const { calibrate } = require('./services/leagueCalibrator')
        calibrate().catch(() => {})
      } catch (e) {
        logger.warn(`[STARTUP] Calibrator init: ${e.message}`)
      }
    }, 2000)

    // Bootstrap: fetch fixtures + stats from working APIs at startup
    setTimeout(async () => {
      try {
        const bsd = require('./services/bsdService')
        if (bsd.isAvailable()) {
          logger.info('[STARTUP] BSD API available — syncing fixtures...')
          await bsd.fullSync().then(n => logger.info(`[STARTUP] BSD sync complete: ${n} matches`))
        }
      } catch (e) {
        logger.warn(`[STARTUP] BSD sync skipped: ${e.message}`)
      }

      // Fetch WC2026 match data from Football-Data.org (has real scores + standings)
      try {
        const fdKey = process.env.FOOTBALLDATA_KEY || ''
        if (fdKey && !fdKey.startsWith('CHANGER_MOI')) {
          const https = require('https')
          const db = require('./core/database')
          const today = new Date().toISOString().split('T')[0]
          const url = `https://api.football-data.org/v4/competitions/WC/matches?dateFrom=${today}&dateTo=${today}`
          logger.info('[STARTUP] Fetching WC2026 data from Football-Data.org...')
          const body = await new Promise((resolve, reject) => {
            https.get(url, { headers: { 'X-Auth-Token': fdKey } }, res => {
              let d = ''
              res.on('data', c => d += c)
              res.on('end', () => resolve(d))
            }).on('error', reject)
          })
          const data = JSON.parse(body)
          const matches = data.matches || []
          logger.info(`[STARTUP] Football-Data: ${matches.length} WC2026 matches today`)
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
          logger.info('[STARTUP] Football-Data sync done')
        }
      } catch (e) {
        logger.warn(`[STARTUP] Football-Data sync failed: ${e.message}`)
      }
    }, 5000)

    const startServer = (retries = 5, host = '0.0.0.0') => {
      logger.info(`[PORT] Attempting to bind to PORT=${PORT} host=${host} (retries left: ${retries})`)
      server.listen(PORT, host, () => {
        logger.info(`🚀 Titanium Server listening at http://${host}:${PORT}`);
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
                logger.info('🔍 [DIAGNOSTIC] API keys manquantes sur Render Dashboard:')
                missing.forEach(([, name]) => logger.info(`   ❌ ${name}`))
                logger.info('   → Allez sur https://dashboard.render.com → Environment → ajoutez ces clés')
              } else {
                logger.info('✅ [DIAGNOSTIC] Toutes les clés API sont configurées')
              }
            } else {
              logger.info('🔍 [DIAGNOSTIC] LOCAL_DATA_URL actif — API keys ignorées, tout passe par ngrok')
            }

            if (process.env.DISABLE_BACKUP !== 'true') backupService.startAutomatedBackups();
            if (process.env.TELEGRAM_BOT_TOKEN) {
              botService.startPolling();
            } else {
              logger.warn('⚠️ [STARTUP] TELEGRAM_BOT_TOKEN not set — bot polling disabled');
            }
            
            await redisCache.init().catch(e => logger.warn('Redis error:', e.message));
            
            cronManager.init(socketService);

            // ⏰ Inline fallback enricher (pure JS, no Python dependency) — runs every 20 min
            const fallbackEnricher = require('./core/fallback_enricher');
            setInterval(async () => {
              logger.info('[SERVER] ⏰ Inline fallback enrichment cycle...');
              try {
                const result = await fallbackEnricher.enrichMatchesBatch();
                if (result.enriched > 0) {
                  logger.info(`[SERVER] ✅ Inline fallback: ${result.enriched}/${result.total} enriched`);
                }
              } catch (e) {
                logger.warn(`[SERVER] ⚠️ Inline fallback error: ${e.message}`);
              }
            }, 20 * 60 * 1000);
            // Also run once 30s after startup to clear any backlog
            setTimeout(async () => {
              logger.info('[SERVER] ⏰ Initial inline fallback enrichment (startup)...');
              try {
                const result = await fallbackEnricher.enrichMatchesBatch();
                logger.info(`[SERVER] ✅ Initial fallback: ${result.enriched}/${result.total} enriched`);
              } catch (e) {
                logger.warn(`[SERVER] ⚠️ Initial fallback error: ${e.message}`);
              }
            }, 30000);

            // 🏁 Inline settlement engine — runs every 15 min
            const settlementService = require('./services/settlementService');
            setInterval(async () => {
              logger.info('[SERVER] ⏰ Settlement cycle...');
              try {
                const result = await settlementService.settleFinishedMatches();
                if (result.settled > 0) {
                  logger.info(`[SERVER] ✅ Settlement: ${result.settled}/${result.total} settled`);
                }
              } catch (e) {
                logger.warn(`[SERVER] ⚠️ Settlement error: ${e.message}`);
              }
            }, 15 * 60 * 1000);
            // Also fetch missing scores 90s after startup
            setTimeout(async () => {
              logger.info('[SERVER] ⏰ Initial missing-score fetch (startup)...');
              try {
                const result = await settlementService.fetchMissingScores();
                if (result.fetched > 0) {
                  logger.info(`[SERVER] ✅ Missing scores: ${result.fetched} fetched`);
                }
                // Then settle those new scores
                const settleResult = await settlementService.settleFinishedMatches();
                logger.info(`[SERVER] ✅ Initial settlement: ${settleResult.settled}/${settleResult.total} settled`);
              } catch (e) {
                logger.warn(`[SERVER] ⚠️ Initial settlement error: ${e.message}`);
              }
            }, 90000);

            await retroSync.syncPastMatches().catch(e => logger.warn(`[RETROSYNC] Error: ${e.message}`));
            clvService.start().catch(e => logger.warn(`[CLV] Error: ${e.message}`));
            const scrapedOddsService = require('./services/scrapedOddsService');
            scrapedOddsService.ensureTable().catch(e => logger.warn(`[SCRAPED_ODDS] Init: ${e.message}`));
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
                  // Phase 3: purge old demo seeds from both PG and SQLite
                  const { query: pgRaw } = require('./core/pg_connector')
                  await pgRaw(`DELETE FROM matches WHERE source IN ('seed', 'emergency')`).catch(() => {})
                  await database.exec("DELETE FROM matches WHERE source IN ('seed', 'emergency')").catch(() => {})
                  logger.info('🧹 [SUPABASE] Purged old demo seeds from PG + SQLite')
                  // Phase 4: continuous sync every 5 min
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

            // 🧹 [EMERGENCY SEED SUPPRIMÉ] Les données persistent via Supabase/PostgreSQL + cloud seed
            // Seeder des matchs démo empêchait la récupération des vrais matchs.

            // 🌱 [CLOUD-SEED] Auto-populate DB on fresh Render deployment (no Puppeteer needed)
            try {
              const { runCloudSeed } = require('./core/cloudSeed');
              runCloudSeed().then(async () => {
                // Clean up any placeholder matches that might have been inserted
                database.cleanupPlaceholderTeams()
                // 🔄 Auto-enrich matches after seeding (deferred to avoid blocking health check)
                setTimeout(async () => {
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
                }, 15000)
              }).catch(e => logger.warn('⚠️ [CLOUD-SEED] Error:', e.message));
            } catch (seedErr) {
              logger.warn('⚠️ [CLOUD-SEED] Module load failed:', seedErr.message);
            }

            // ⚠️ [EMERGENCY SEED] Vérifie que des données réelles existent
            (async () => {
              try {
                const count = await database.query('SELECT COUNT(*) as cnt FROM matches')
                const matchCount = count?.rows?.[0]?.cnt || 0
                if (matchCount < 10) {
                  logger.warn(`[EMERGENCY-SEED] ⚠️ DB n'a que ${matchCount} matchs — aucune donnée réelle disponible. Vérifie les APIs.`)
                  logger.warn(`[EMERGENCY-SEED] Les APIs suivantes nécessitent des clés : BSD, APIFootball, Sportmonks, TheRundown, etc.`)
                  logger.warn(`[EMERGENCY-SEED] Les sources gratuites (SofaScore, OpenLigaDB) ont échoué ou sont indisponibles.`)
                } else {
                  logger.info(`[EMERGENCY-SEED] DB OK: ${matchCount} matchs réels`)
                }
              } catch (e) {
                logger.warn(`[EMERGENCY-SEED] Error: ${e.message}`)
              }
            })()



            // 📊 [DIAGNOSTIC COMPLET] Rapport sur les données réelles
            setTimeout(() => {
              try {
                const db = database.db
                if (!db) { logger.warn('[DIAGNOSTIC] DB non initialisée'); return }
                const total = (db.prepare('SELECT COUNT(*) as c FROM matches').get() || {}).c || 0
                const scheduled = (db.prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('scheduled','notstarted','NS')").get() || {}).c || 0
                const finished = (db.prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('FT','finished','Ended')").get() || {}).c || 0
                const withOdds = (db.prepare('SELECT COUNT(*) as c FROM matches WHERE odds_home IS NOT NULL').get() || {}).c || 0
                const withPredictions = (db.prepare("SELECT COUNT(*) as c FROM matches WHERE expected_score IS NOT NULL AND expected_score != 'N/A'").get() || {}).c || 0
                const withXG = (db.prepare('SELECT COUNT(*) as c FROM matches WHERE home_xg IS NOT NULL').get() || {}).c || 0
                const today = (db.prepare("SELECT COUNT(*) as c FROM matches WHERE DATE(timestamp / 1000, 'unixepoch') = DATE('now')").get() || {}).c || 0
                const tomorrow = (db.prepare("SELECT COUNT(*) as c FROM matches WHERE DATE(timestamp / 1000, 'unixepoch') = DATE('now', '+1 day')").get() || {}).c || 0
                logger.info('══════════════════════════════════════════')
                logger.info('📊 DIAGNOSTIC DES DONNÉES')
                logger.info(`   Matchs total:         ${total}`)
                logger.info(`   À venir:              ${scheduled}`)
                logger.info(`   Terminés:             ${finished}`)
                logger.info(`   Avec cotes:           ${withOdds}`)
                logger.info(`   Avec prédictions:     ${withPredictions}`)
                logger.info(`   Avec xG:              ${withXG}`)
                logger.info(`   Aujourd\'hui:          ${today}`)
                logger.info(`   Demain:               ${tomorrow}`)
                if (scheduled < 10) logger.warn(`   ⚠️  MOINS DE 10 MATCHS DISPONIBLES — site quasiment vide`)
                if (withPredictions < 5) logger.warn(`   ⚠️  MOINS DE 5 PRÉDICTIONS — l\'IA n\'a presque rien à afficher`)
                if (withOdds === 0) logger.warn(`   ⚠️  AUCUNE COTE — EV/chirurgical désactivé`)
                logger.info('══════════════════════════════════════════')
              } catch (e) {
                logger.warn(`[DIAGNOSTIC] Erreur: ${e.message}`)
              }
            }, 10000)

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

            // 📊 [HEALTH] Schedule daily health report at 07:00 UTC
            const scheduleHealthReport = () => {
              const now = new Date()
              const target = new Date()
              target.setUTCHours(7, 0, 0, 0)
              if (target <= now) target.setDate(target.getDate() + 1)
              const delay = target.getTime() - now.getTime()
              setTimeout(async () => {
                try {
                  const { execSync } = require('child_process')
                  const report = execSync('node scripts/daily_health_report.js', { timeout: 30000, encoding: 'utf-8' })
                  logger.info('[HEALTH] Daily report:\n' + report.slice(-500))
                } catch (e) {
                  logger.warn('[HEALTH] Daily report failed:', e.message)
                }
                scheduleHealthReport()
              }, delay)
            }
            scheduleHealthReport()

            // 💾 [BACKUP] Schedule daily DB backup at 03:00 UTC
            const scheduleBackup = () => {
              const now = new Date()
              const target = new Date()
              target.setUTCHours(3, 0, 0, 0)
              if (target <= now) target.setDate(target.getDate() + 1)
              const delay = target.getTime() - now.getTime()
              setTimeout(async () => {
                try {
                  const { execSync } = require('child_process')
                  const result = execSync('node scripts/auto_backup_db.js', { timeout: 60000, encoding: 'utf-8' })
                  logger.info('[BACKUP] Daily backup:\n' + result.slice(-300))
                } catch (e) {
                  logger.warn('[BACKUP] Daily backup failed:', e.message)
                }
                scheduleBackup()
              }, delay)
            }
            scheduleBackup()

            // 🧠 [AUTO-RETRAIN] Schedule weekly XGBoost retraining (Sunday 04:00 UTC)
            const scheduleRetrain = () => {
              const now = new Date()
              const target = new Date()
              target.setUTCHours(4, 0, 0, 0)
              const daysUntilSunday = (7 - target.getDay()) % 7 || 7
              target.setDate(target.getDate() + daysUntilSunday)
              if (target <= now) target.setDate(target.getDate() + 7)
              const delay = target.getTime() - now.getTime()
              setTimeout(async () => {
                try {
                  const { execSync } = require('child_process')
                  const result = execSync('node scripts/auto_retrain_worker.js', { timeout: 300000, encoding: 'utf-8' })
                  logger.info('[AUTO-RETRAIN] Weekly retrain:\n' + result.slice(-500))
                } catch (e) {
                  logger.warn('[AUTO-RETRAIN] Weekly retrain failed:', e.message)
                }
                scheduleRetrain()
              }, delay)
            }
            scheduleRetrain()

            // 🔍 [STARTUP] Log API availability
            setTimeout(() => {
              const sources = [
                { name: 'SofaScore', check: () => !process.env.DISABLE_SOFASCORE },
                { name: 'BSD', check: () => !!process.env.BSD_API_KEY },
                { name: 'FootballData', check: () => !!process.env.FOOTBALLDATA_KEY },
                { name: 'RapidAPI', check: () => !!process.env.RAPIDAPI_KEY },
                { name: 'Sportmonks', check: () => !!process.env.SPORTMONKS_KEY },
                { name: 'APIFootball', check: () => !!process.env.APIFOOTBALL_KEY },
                { name: 'OddsPapi', check: () => !!process.env.ODDSPAPI_KEY },
                { name: 'TheRundown', check: () => !!process.env.THERUNDOWN_KEY },
                { name: 'PredixSport', check: () => !!process.env.PREDIXSPORT_API_KEY },
                { name: 'GROQ', check: () => !!process.env.GROQ_API_KEY },
                { name: 'DeepSeek', check: () => !!process.env.DEEPSEEK_API_KEY },
                { name: 'OpenLigaDB', check: () => true },
                { name: 'Promosport', check: () => true },
              ]
              const available = sources.filter(s => s.check()).map(s => s.name)
              const missing = sources.filter(s => !s.check()).map(s => s.name)
              logger.info(`[STARTUP] APIs available: ${available.join(', ')}`)
              if (missing.length) logger.warn(`[STARTUP] APIs missing keys: ${missing.join(', ')}`)
            }, 5000)
          } catch (initErr) {
            logger.error('💥 [CRITICAL] Service Initialization Error:', initErr.message);
          }
        }, 500);
      }).on('error', async (err) => {
        logger.info(`[PORT] Error binding: ${err.code} - ${err.message}`)
        if (err.code === 'EADDRINUSE') {
          if (retries > 0) {
            logger.warn(`⚠️  Port ${PORT} in use, retrying in 2s... (${retries} retries left)`);
            await killProcessOnPort(PORT);
            setTimeout(() => startServer(retries - 1), 2000);
          } else {
            logger.error(`💥 [FATAL] Port ${PORT} is persistently occupied. Manual intervention required.`);
            process.exit(1);
          }
        } else if (host === '0.0.0.0') {
          logger.info(`[PORT] Address error, retrying without hostname...`)
          setTimeout(() => startServer(retries, undefined), 500)
        } else {
          logger.error(`💥 [FATAL] Server Error: ${err.message}`);
          process.exit(1);
        }
      });
    };

    logger.info(`🔍 [DEBUG] PORT=${PORT} typeof=${typeof PORT} calling startServer()`)
    startServer()
    logger.info('🔍 [DEBUG] startServer() returned')

  } catch (e) {
    logger.error('💥 FATAL STARTUP ERROR:', e.message);
    // Still try to start server even if init failed
    try { startServer(); } catch (e2) {
      logger.error('💥 FATAL startServer error:', e2.message);
      process.exit(1);
    }
  }
})();

process.on('uncaughtException', (err) => {
  const msg = `💥 [FATAL] Uncaught Exception: ${err.message}`
  try { logger.error(msg, { stack: err.stack }) } catch (_) { logger.error(msg) }
  setTimeout(() => process.exit(1), 1000)
})

process.on('unhandledRejection', (reason) => {
  const msg = `⚠️  UNHANDLED REJECTION: ${reason instanceof Error ? reason.message : String(reason)}`
  try { logger.error(msg) } catch (_) { logger.error(msg) }
})

const shutDown = () => {
  logger.info('🛑 Received kill signal, shutting down gracefully');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
};

process.on('SIGTERM', shutDown);
process.on('SIGINT', shutDown);
