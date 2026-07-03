const cron = require('node-cron');
const { spawn } = require('child_process');
const path = require('path');
const logger = require('../core/logger');
const database = require('../core/database');
const redisCache = require('./redisCache');
const workerBridge = require('./workerBridge');
const { runAnalysis } = require('../scripts/today_analysis');
const { snapshotOdds } = require('./oddsMovementService');
const autoArchiver = require('./autoArchiver');
const retroSync = require('./retroSyncService');
const adaptiveLearning = require('./adaptiveLearningEngine');
const enrichedPredictions = require('../core/enriched_predictions');
const { runAutoRetrain } = require('../scripts/auto_retrain_worker');

class CronManager {
    constructor() {
        this.scraperSchedule = { running: false, lastRun: null };
    }

    init(socketService) {
        logger.info('â° [CRON] Initializing master scheduler...');

        // Heartbeat — écrit un timestamp Redis toutes les 5 min
        cron.schedule('*/5 * * * *', async () => {
            try { await redisCache.set('cron:heartbeat', Date.now(), 300).catch(() => {}) } catch (_) {}
        })

        // 1. Nightly accuracy analysis (23:00)
        cron.schedule('0 23 * * *', async () => {
            try {
                const date = new Date().toISOString().split('T')[0];
                const result = await runAnalysis(date);
                if (result) logger.info(`✅ [CRON] Accuracy: ${result.accuracy}%`);
            } catch (e) { logger.error(`❌ [CRON] Accuracy Error: ${e.message}`); }
        }, { timezone: 'Europe/Paris' });

        // 2. Auto-Scraper (toutes les 3h de 06:00 Ã  21:00)
        cron.schedule('0 6,9,12,15,18,21 * * *', (label) => this.launchScraper(label), { timezone: 'Europe/Paris' });

        // 3. Odds snapshot (Every 2 hours)
        cron.schedule('0 */2 * * *', async () => {
            try {
                const matches = await database.getTodayMatches?.() || [];
                if (matches.length > 0) snapshotOdds(matches);
            } catch (e) { logger.error(`âŒ [CRON] Odds Error: ${e.message}`); }
        }, { timezone: 'Europe/Paris' });

        // 4. Daily Auto-Archiver (04:00)
        cron.schedule('0 4 * * *', () => autoArchiver.runArchiver(2), { timezone: 'Europe/Paris' });

        // 5. Online Learning Incremental Update (every 6 hours â€” after archiver at 04:00)
        cron.schedule('30 */6 * * *', () => {
            logger.info('ðŸ§  [CRON] Launching Online Learning Incremental Update...');
            const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'online_learning_update.js')], { stdio: 'inherit', windowsHide: true });
            proc.on('close', code => logger.info(`âœ… [CRON] Online Learning finished (code ${code})`));
        }, { timezone: 'Africa/Tunis' });

        // 6. Periodic H2H Reinforcement (05:00)
        cron.schedule('0 5 * * *', () => {
            const proc = spawn('node', [path.join(__dirname, '..', 'tools', 'reinject_h2h.js')], { stdio: 'inherit', windowsHide: true });
            proc.on('close', code => logger.info(`âœ… [CRON] H2H Success (code ${code})`));
        }, { timezone: 'Europe/Paris' });

        // 6. Retro-Sync (Every 3 hours) â€” try Account 2 worker first
        cron.schedule('0 */3 * * *', async () => {
            const result = await workerBridge.callWorker('sync/retro')
            if (!result?.success) {
                await retroSync.syncPastMatches()
            }
        }, { timezone: 'Europe/Paris' });

        // 7. Adaptive Learning Engine (02:30)
        cron.schedule('30 2 * * *', () => this.runAdaptiveLearning(), { timezone: 'Europe/Paris' });

        // 8. Cache cleanup + deltaEngine cleanup (Every 6 hours)
        cron.schedule('0 */6 * * *', () => {
            redisCache.clearExpired()
            const deltaEngine = require('./deltaEngine')
            deltaEngine.cleanup()
        })

        // 9. Combo Refresh (Every hour)
        cron.schedule('0 * * * *', () => socketService.refreshCombos());

        // 10. Proactive Future Enrichment (every 4 hours) â€” try Account 2 worker first
        cron.schedule('0 0,4,8,12,16,20 * * *', async () => {
            const result = await workerBridge.callWorker('enrich')
            if (!result?.success) {
                await this.runProactiveEnrichment()
            }
        }, { timezone: 'Europe/Paris' });

        // 9.5 Tunisian Promosport Crowd Collector (08:00 daily)
        cron.schedule('0 8 * * *', () => {
            logger.info('ðŸ‡¹ðŸ‡³ [CRON] Launching Tunisian Crowd Collector...');
            const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'crowd_collector.js')], { stdio: 'inherit', windowsHide: true });
            proc.on('close', code => logger.info(`âœ… [CRON] Tunisian Crowd finished (code ${code})`));
        }, { timezone: 'Africa/Tunis' });

        // 10.1 Universal Omniscience Predictor (Every 2 hours for near-real-time tactical updates)
        cron.schedule('0 */2 * * *', () => {
            logger.info('ðŸš€ [CRON] Launching Universal Bulk Predictor...');
            const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'universal_predictor.js')], { stdio: 'inherit', windowsHide: true });
            proc.on('close', code => logger.info(`âœ… [CRON] Universal Predictor finished (code ${code})`));
        }, { timezone: 'Europe/Paris' });
        
        // 10.2 Daily Surgical Elite 50 â€” Main dispatch 10:00 AM (after 06:00 scraper)
        cron.schedule('0 10 * * *', () => {
            logger.info('ðŸš€ [CRON] Launching Surgical Elite 50 Pronostic (10:00 AM)...');
            const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'surgical_elite_50.js')], { stdio: 'inherit', windowsHide: true });
            proc.on('close', code => logger.info(`âœ… [CRON] Surgical Elite 50 finished (code ${code})`));
        }, { timezone: 'Europe/Paris' });

        // 10.3 Afternoon Elite 50 refresh â€” 14:00 PM
        cron.schedule('0 14 * * *', () => {
            logger.info('ðŸš€ [CRON] Launching Surgical Elite 50 Afternoon Refresh...');
            const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'surgical_elite_50.js')], { stdio: 'inherit', windowsHide: true });
            proc.on('close', code => logger.info(`âœ… [CRON] Elite 50 Afternoon finished (code ${code})`));
        }, { timezone: 'Europe/Paris' });

        // 10.2 Daily MR. X Draw Oracle Broadcast (10:00 AM)
        cron.schedule('0 10 * * *', () => {
            logger.info('ðŸš€ [CRON] Launching MR. X Daily Broadcast...');
            const botService = require('./botService');
            botService.sendMrXBroadcast();
        }, { timezone: 'Europe/Paris' });
        
        // 11. Database Maintenance (03:00 AM) â€” try Account 2 worker first
        cron.schedule('0 3 * * *', async () => {
            const result = await workerBridge.callWorker('db/maintenance')
            if (!result?.success) {
                await database.maintenance()
            }
        }, { timezone: 'Europe/Paris' });
        
        // 12. Monthly Auto-Retrain (04:00 AM 1st of every month)
        cron.schedule('0 4 1 * *', () => {
            logger.info('ðŸš€ [CRON] Launching Monthly XGBoost Auto-Retrain...');
            runAutoRetrain().then(res => {
                if (res.success) {
                    const botService = require('./botService');
                    botService.sendAlert(`ðŸ”¥ <b>TITANIUM AUTO-RETRAIN (CRON)</b> ðŸ”¥\n\n${res.message}`);
                }
            }).catch(e => logger.error(`[CRON] Auto-Retrain failed: ${e}`));
        }, { timezone: 'Africa/Tunis' });

        // 12b. Weekly Live Model Retrain (05:00 AM every Sunday)
        cron.schedule('0 5 * * 0', () => {
            logger.info('ðŸš€ [CRON] Launching Weekly Live Goal Model Retrain...');
            const { runLiveModelRetrain } = require('../scripts/auto_retrain_worker');
            runLiveModelRetrain().then(res => {
                if (res.success) {
                    logger.info('âœ… [CRON] Live goal model retrained successfully')
                }
            })
        }, { timezone: 'Africa/Tunis' });

        // 12c. Weekly Dixon-Coles MLE GoalModel Fit (06:00 AM every Sunday)
        cron.schedule('0 6 * * 0', async () => {
            logger.info('ðŸ“ [CRON] Launching Weekly Dixon-Coles GoalModel MLE Fit...');
            try {
                const http = require('http')
                const body = JSON.stringify({})
                const opts = {
                    hostname: '127.0.0.1', port: 5000, path: '/api/goalmodel/fit',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                    timeout: 300000
                }
                const result = await new Promise((resolve, reject) => {
                    const req = http.request(opts, r => {
                        let data = ''
                        r.on('data', c => data += c)
                        r.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { resolve({ raw: data }) } })
                    })
                    req.on('error', reject)
                    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
                    req.write(body)
                    req.end()
                })
                if (result?.success) {
                    logger.info(`âœ… [CRON] GoalModel fit started: ${result.total} leagues`)
                } else {
                    logger.warn(`âš ï¸ [CRON] GoalModel fit issue: ${JSON.stringify(result)}`)
                }
            } catch (e) {
                logger.error(`âŒ [CRON] GoalModel fit failed: ${e.message}`)
            }
        }, { timezone: 'Africa/Tunis' })

        // 13. [TITANIUM] Daily Surgical Dispatch (09:00 AM)
        cron.schedule('0 9 * * *', () => {
            logger.info('ðŸš€ [CRON] Launching Daily Surgical Dispatch...');
            const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'surgical_daily_dispatch.js')], { stdio: 'inherit', windowsHide: true });
            proc.on('close', code => logger.info(`âœ… [CRON] Surgical Dispatch finished (code ${code})`));
        }, { timezone: 'Africa/Tunis' });

        // 14. [TITANIUM] Hourly Results Update (Every hour at :15 to catch finished matches)
        cron.schedule('15 * * * *', () => {
            logger.info('ðŸš€ [CRON] Launching Hourly Results Report...');
            const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'surgical_results_report.js')], { stdio: 'inherit', windowsHide: true });
            proc.on('close', code => logger.info(`âœ… [CRON] Results Report finished (code ${code})`));
        }, { timezone: 'Africa/Tunis' });

        // 15. [AUTOHEAL] Autopilot system patrol (Every 15 minutes) â€” includes stale xG detection & fix
        cron.schedule('*/15 * * * *', () => {
            try {
                const autoHealAgent = require('./autoHealAgent');
                autoHealAgent.patrol();
            } catch (e) {
                logger.error(`âŒ [CRON] AutoHeal patrol error: ${e.message}`);
            }
        });

        // 16. PredixSport Sync (Every 6 hours) â€” try Account 2 worker first
        cron.schedule('0 */6 * * *', async () => {
          const result = await workerBridge.callWorker('sync/predixsport')
          if (!result?.success) {
            try {
              const predixSportService = require('./predixSportService')
              await predixSportService.syncUpcoming()
            } catch (e) {
              logger.error(`[CRON] PredixSport sync error: ${e.message}`)
            }
          }
        }, { timezone: 'Europe/Paris' })

        // 17. Big Balls Data Sync (Every 12 hours) â€” try Account 2 worker first
        cron.schedule('0 */12 * * *', async () => {
          const result = await workerBridge.callWorker('sync/bigballsdata')
          if (!result?.success) {
            try {
              const bbs = require('./bigBallsDataService')
              await bbs.syncUpcoming()
            } catch (e) {
              logger.error(`[CRON] BBS sync error: ${e.message}`)
            }
          }
        }, { timezone: 'Europe/Paris' })

        // 18. BSD Sync (Every 6 hours) â€” via Account 2 worker
        cron.schedule('0 */6 * * *', async () => {
          const result = await workerBridge.callWorker('sync/bsd')
          if (!result?.success) {
            logger.info('[CRON] BSD sync skipped â€” no local fallback available')
          }
        }, { timezone: 'Europe/Paris' })

        // 19. Archive finished matches (Daily at 04:30) â€” via Account 2 worker
        cron.schedule('30 4 * * *', async () => {
          const result = await workerBridge.callWorker('sync/archive')
          if (!result?.success) {
            try {
              await database.archiveFinishedMatches()
            } catch (e) {
              logger.error(`[CRON] Archive error: ${e.message}`)
            }
          }
        }, { timezone: 'Europe/Paris' })

        
        // 19b. Quick archive check (Every 2h, 8-23,0-2) � updates prediction results
        cron.schedule('0 8-23,0-2 * * *', async () => {
          try {
            const res = await database.archiveFinishedMatches()
            if (res?.archivedCount > 0) {
              logger.info(`[CRON] Quick archive: ${res.archivedCount} matches`)
            }
          } catch (e) {
            logger.error(`[CRON] Quick archive error: ${e.message}`)
          }
        }, { timezone: 'Europe/Paris' })

        // 20. OpenLigaDB Sync (Daily at 05:00) â€” via Account 2 worker
        cron.schedule('0 5 * * *', async () => {
          await workerBridge.callWorker('sync/openligadb')
        }, { timezone: 'Europe/Paris' })

        // 21. Live Value Alerts (Every 5 min, 9:00-23:59) â€” detects EV+ live bets
        cron.schedule('*/5 9-23 * * *', () => {
          const scriptPath = path.join(__dirname, '..', 'scripts', 'live_value_alerts.js')
          if (require('fs').existsSync(scriptPath)) {
            const proc = spawn('node', [scriptPath, '--once'], { stdio: 'ignore', windowsHide: true })
            proc.unref()
          }
        }, { timezone: 'Europe/Paris' })

        // 22. FastAPI Keepalive (Every 5 min) — prevents cold start on free tier + warm engines
        cron.schedule('*/5 * * * *', async () => {
          const https = require('https')
          const fastApiUrl = process.env.INFERENCE_URL || 'https://prono-fastapi.onrender.com'
          const urls = [fastApiUrl + '/health', fastApiUrl + '/warmup', 'https://prono-scraper.onrender.com/health']
          for (const url of urls) {
            try {
              await new Promise((resolve, reject) => {
                const req = https.get(url, { timeout: 15000 }, (res) => { res.resume(); resolve() })
                req.on('error', () => resolve())
                req.on('timeout', () => { req.destroy(); resolve() })
              })
            } catch (_) {}
          }
        }, { timezone: 'Europe/Paris' })

        // 23. Weekly Platt Calibration + XGBoost Retrain (Sunday 03:00 UTC)
        cron.schedule('0 3 * * 0', async () => {
          logger.info('[CRON] Launching weekly Platt calibration...')
          const https = require('https')
          const fastApiUrl = process.env.INFERENCE_URL || 'https://prono-fastapi.onrender.com'
          const apiKey = process.env.API_SECRET_KEY || ''
          const postJson = (path, body) => new Promise((resolve) => {
            const data = JSON.stringify(body)
            const urlObj = new URL(fastApiUrl.replace(/\/+$/, '') + path)
            const opts = {
              hostname: urlObj.hostname, port: 443, path: urlObj.pathname,
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
              timeout: 300000
            }
            if (apiKey) opts.headers['Authorization'] = 'Bearer ' + apiKey
            const req = https.request(opts, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch (_) { resolve({ raw: d }) } }) })
            req.on('error', () => resolve({}))
            req.on('timeout', () => { req.destroy(); resolve({}) })
            req.write(data)
            req.end()
          })
          let calRes = await postJson('/calibrate', {})
          logger.info(`[CRON] Calibrate: ${calRes.success ? 'OK' : 'FAIL'} (${calRes.samples || 0} samples)`)
          let retrainRes = await postJson('/retrain', {})
          logger.info(`[CRON] Retrain: ${retrainRes.success ? 'OK' : 'FAIL'} — ${retrainRes.message || ''}`)
        }, { timezone: 'UTC' })

        logger.info('âœ… [CRON] Scheduler active');

        // ðŸš€ [RESUME] Disabled to avoid conflict with standalone scraper process
        /*
        setTimeout(() => {
            logger.info('ðŸ”„ [CRON] Resuming scraper from where it left off on server startup...');
            this.launchScraper('startup-resume');
        }, 30000);
        */
    }

    async launchScraper(label) {
        if (this.scraperSchedule.running) return;
        
        // ðŸ”’ [LOCK CHECK] If the external scraper process already holds the Redis lock,
        // skip spawning a duplicate.
        try {
            const isLocked = await redisCache.get('scraper:lock');
            if (isLocked) {
                logger.info(`ðŸš« [CRON] Scraper (${label}) skipped â€” external instance already active (Redis lock held).`);
                return;
            }
        } catch (lockErr) {
            logger.warn(`âš ï¸ [CRON] Could not check scraper lock: ${lockErr.message}. Proceeding with launch.`);
        }

        this.scraperSchedule.running = true;
        this.scraperSchedule.lastRun = new Date().toISOString();
        
        // â±ï¸ Auto-reset after 30 minutes si le flag reste bloquÃ©
        const safetyTimer = setTimeout(() => {
            if (this.scraperSchedule.running) {
                logger.warn(`âš ï¸ [CRON] Scraper (${label}) safety timeout â€” auto-reset running flag`)
                this.scraperSchedule.running = false
            }
        }, 30 * 60 * 1000)
        
        logger.info(`ðŸ“¡ [CRON] Launching Scraper (${label}) via bridge...`);
        
        // Use scraper bridge: calls serverless worker if configured, otherwise runs locally
        const scraperBridge = require('./scraperBridge')
        try {
            await scraperBridge.triggerScrape()
        } catch (err) {
            logger.error(`[CRON] Scraper bridge failed: ${err.message}`)
        }
        
        clearTimeout(safetyTimer)
        this.scraperSchedule.running = false;
        await redisCache.setLastRun(Date.now()).catch(() => {});
        await redisCache.redis?.del('scraper:lock').catch(() => {});
        logger.info(`âœ… [CRON] Scraper (${label}) finished via bridge.`);
    }

    async runAdaptiveLearning() {
        try {
            const db = database.db;
            const rows = db.prepare("SELECT * FROM matches WHERE status IN ('FT','Finished') LIMIT 200").all();
            if (rows.length > 0) await adaptiveLearning.processBatch(rows);
        } catch (e) { logger.error(`âŒ [CRON] Learning Error: ${e.message}`); }
    }

    async runProactiveEnrichment() {
        try {
            logger.info('ðŸ§  [CRON] Starting proactive 4-hour enrichment cycle...');
            const now = Date.now();
            const lookupEnd = now + (3 * 24 * 60 * 60 * 1000);
            
            // Get scheduled matches for the next 7 days
            const matches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']);
            const needsEnrichment = matches.filter(m => {
                const ts = m.startTimestamp ? m.startTimestamp * 1000 : (m.timestamp ? new Date(m.timestamp).getTime() : 0);
                const isFuture = ts > now - 3600000 && ts < lookupEnd;
                const isStale = !m.home_win_probability || parseFloat(m.home_win_probability) === 0;
                return isFuture && isStale;
            }).slice(0, 300); // ðŸš€ Increased from 50 to 300 to fulfill the "minimum 50" requirement across all markets

            let filteredNeedsEnrichment = needsEnrichment;
            if (process.env.RAPIDAPI_ENABLED === 'true') {
                const rapidApiQuotaManager = require('./rapidApiQuotaManager');
                const quotaStatus = rapidApiQuotaManager.getQuotaStatus();
                
                if (quotaStatus.remaining <= 0) {
                    logger.warn('ðŸ›‘ [CRON] Proactive enrichment skipped â€” RapidAPI quota is exhausted. Running FootballData.io fallback...');
                    try {
                        const footballDataService = require('./footballDataService');
                        await footballDataService.processFallbackFixtures();
                    } catch (fdErr) {
                        logger.error(`âŒ [CRON] FootballData fallback failed: ${fdErr.message}`);
                    }
                    return;
                }
                
                // Keep only matches within the quota
                filteredNeedsEnrichment = [];
                for (const m of needsEnrichment) {
                    if (rapidApiQuotaManager.canProcessMatch(m.id)) {
                        rapidApiQuotaManager.registerMatch(m.id);
                        filteredNeedsEnrichment.push(m);
                    }
                    if (filteredNeedsEnrichment.length >= quotaStatus.remaining) break;
                }
                
                logger.info(`ðŸ§  [CRON] RapidAPI active: filtered enrichment to ${filteredNeedsEnrichment.length} matches within remaining quota (${quotaStatus.remaining}).`);
            }

            if (filteredNeedsEnrichment.length > 0) {
                logger.info(`ðŸ§  [CRON] Enriching ${filteredNeedsEnrichment.length} future matches...`);
                const enriched = await enrichedPredictions.enrichMatches(filteredNeedsEnrichment);
                for (const m of enriched) {
                    await database.updatePredictions(m.id, m);
                }
                logger.info('âœ… [CRON] Proactive enrichment cycle complete.');
            } else {
                logger.info('âœ… [CRON] All future matches are already up to date.');
            }
        } catch (e) {
            logger.error(`âŒ [CRON] Proactive Enrichment Error: ${e.message}`);
        }
    }
}

module.exports = new CronManager();
