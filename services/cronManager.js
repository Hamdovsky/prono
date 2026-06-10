const cron = require('node-cron');
const { spawn } = require('child_process');
const path = require('path');
const logger = require('../core/logger');
const database = require('../core/database');
const redisCache = require('./redisCache');
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
        logger.info('⏰ [CRON] Initializing master scheduler...');

        // 1. Nightly accuracy analysis (23:00)
        cron.schedule('0 23 * * *', async () => {
            try {
                const date = new Date().toISOString().split('T')[0];
                const result = await runAnalysis(date);
                if (result) logger.info(`✅ [CRON] Accuracy: ${result.accuracy}%`);
            } catch (e) { logger.error(`❌ [CRON] Accuracy Error: ${e.message}`); }
        }, { timezone: 'Europe/Paris' });

        // 2. Auto-Scraper (06:00, 12:00, 18:00)
        cron.schedule('0 6,12,18 * * *', (label) => this.launchScraper(label), { timezone: 'Europe/Paris' });

        // 3. Odds snapshot (Every 2 hours)
        cron.schedule('0 */2 * * *', async () => {
            try {
                const matches = await database.getTodayMatches?.() || [];
                if (matches.length > 0) snapshotOdds(matches);
            } catch (e) { logger.error(`❌ [CRON] Odds Error: ${e.message}`); }
        }, { timezone: 'Europe/Paris' });

        // 4. Daily Auto-Archiver (04:00)
        cron.schedule('0 4 * * *', () => autoArchiver.runArchiver(2), { timezone: 'Europe/Paris' });

        // 5. Online Learning Incremental Update (every 6 hours — after archiver at 04:00)
        cron.schedule('30 */6 * * *', () => {
            logger.info('🧠 [CRON] Launching Online Learning Incremental Update...');
            const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'online_learning_update.js')], { stdio: 'inherit', windowsHide: true });
            proc.on('close', code => logger.info(`✅ [CRON] Online Learning finished (code ${code})`));
        }, { timezone: 'Africa/Tunis' });

        // 6. Periodic H2H Reinforcement (05:00)
        cron.schedule('0 5 * * *', () => {
            const proc = spawn('node', [path.join(__dirname, '..', 'tools', 'reinject_h2h.js')], { stdio: 'inherit', windowsHide: true });
            proc.on('close', code => logger.info(`✅ [CRON] H2H Success (code ${code})`));
        }, { timezone: 'Europe/Paris' });

        // 6. Retro-Sync (Every 3 hours)
        cron.schedule('0 */3 * * *', () => retroSync.syncPastMatches(), { timezone: 'Europe/Paris' });

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

        // 10. Proactive Future Enrichment (01:00, 07:00, 13:00, 19:00)
        cron.schedule('0 1,7,13,19 * * *', () => this.runProactiveEnrichment(), { timezone: 'Europe/Paris' });

        // 10.1 Universal Omniscience Predictor (Every 2 hours for near-real-time tactical updates)
        cron.schedule('0 */2 * * *', () => {
            logger.info('🚀 [CRON] Launching Universal Bulk Predictor...');
            const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'universal_predictor.js')], { stdio: 'inherit', windowsHide: true });
            proc.on('close', code => logger.info(`✅ [CRON] Universal Predictor finished (code ${code})`));
        }, { timezone: 'Europe/Paris' });
        
        // 10.2 Daily Surgical Elite 50 — Main dispatch 10:00 AM (after 06:00 scraper)
        cron.schedule('0 10 * * *', () => {
            logger.info('🚀 [CRON] Launching Surgical Elite 50 Pronostic (10:00 AM)...');
            const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'surgical_elite_50.js')], { stdio: 'inherit', windowsHide: true });
            proc.on('close', code => logger.info(`✅ [CRON] Surgical Elite 50 finished (code ${code})`));
        }, { timezone: 'Europe/Paris' });

        // 10.3 Afternoon Elite 50 refresh — 14:00 PM
        cron.schedule('0 14 * * *', () => {
            logger.info('🚀 [CRON] Launching Surgical Elite 50 Afternoon Refresh...');
            const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'surgical_elite_50.js')], { stdio: 'inherit', windowsHide: true });
            proc.on('close', code => logger.info(`✅ [CRON] Elite 50 Afternoon finished (code ${code})`));
        }, { timezone: 'Europe/Paris' });

        // 10.2 Daily MR. X Draw Oracle Broadcast (10:00 AM)
        cron.schedule('0 10 * * *', () => {
            logger.info('🚀 [CRON] Launching MR. X Daily Broadcast...');
            const botService = require('./botService');
            botService.sendMrXBroadcast();
        }, { timezone: 'Europe/Paris' });
        
        // 11. Database Maintenance (03:00 AM) - [RAM OPTIMIZATION]
        cron.schedule('0 3 * * *', () => database.maintenance(), { timezone: 'Europe/Paris' });
        
        // 12. Monthly Auto-Retrain (04:00 AM 1st of every month)
        cron.schedule('0 4 1 * *', () => {
            logger.info('🚀 [CRON] Launching Monthly XGBoost Auto-Retrain...');
            runAutoRetrain().then(res => {
                if (res.success) {
                    const botService = require('./botService');
                    botService.sendAlert(`🔥 <b>TITANIUM AUTO-RETRAIN (CRON)</b> 🔥\n\n${res.message}`);
                }
            }).catch(e => logger.error(`[CRON] Auto-Retrain failed: ${e}`));
        }, { timezone: 'Africa/Tunis' });

        // 13. [TITANIUM] Daily Surgical Dispatch (09:00 AM)
        cron.schedule('0 9 * * *', () => {
            logger.info('🚀 [CRON] Launching Daily Surgical Dispatch...');
            const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'surgical_daily_dispatch.js')], { stdio: 'inherit', windowsHide: true });
            proc.on('close', code => logger.info(`✅ [CRON] Surgical Dispatch finished (code ${code})`));
        }, { timezone: 'Africa/Tunis' });

        // 14. [TITANIUM] Hourly Results Update (Every hour at :15 to catch finished matches)
        cron.schedule('15 * * * *', () => {
            logger.info('🚀 [CRON] Launching Hourly Results Report...');
            const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'surgical_results_report.js')], { stdio: 'inherit', windowsHide: true });
            proc.on('close', code => logger.info(`✅ [CRON] Results Report finished (code ${code})`));
        }, { timezone: 'Africa/Tunis' });

        // 15. [AUTOHEAL] Autopilot system patrol (Every 30 minutes)
        cron.schedule('*/30 * * * *', () => {
            try {
                const autoHealAgent = require('./autoHealAgent');
                autoHealAgent.patrol();
            } catch (e) {
                logger.error(`❌ [CRON] AutoHeal patrol error: ${e.message}`);
            }
        });

        // 16. PredixSport Sync (Every 6 hours)
        cron.schedule('0 */6 * * *', async () => {
          try {
            const predixSportService = require('./predixSportService')
            await predixSportService.syncUpcoming()
          } catch (e) {
            logger.error(`[CRON] PredixSport sync error: ${e.message}`)
          }
        }, { timezone: 'Europe/Paris' })

        // 17. Big Balls Data Sync (Every 12 hours — xG/stats for training)
        cron.schedule('0 */12 * * *', async () => {
          try {
            const bbs = require('./bigBallsDataService')
            await bbs.syncUpcoming()
          } catch (e) {
            logger.error(`[CRON] BBS sync error: ${e.message}`)
          }
        }, { timezone: 'Europe/Paris' })

        logger.info('✅ [CRON] Scheduler active');

        // 🚀 [RESUME] Disabled to avoid conflict with standalone scraper process
        /*
        setTimeout(() => {
            logger.info('🔄 [CRON] Resuming scraper from where it left off on server startup...');
            this.launchScraper('startup-resume');
        }, 30000);
        */
    }

    async launchScraper(label) {
        if (this.scraperSchedule.running) return;
        
        // 🔒 [LOCK CHECK] If the external scraper process already holds the Redis lock,
        // skip spawning a duplicate. The external process releases the lock when it finishes.
        try {
            const isLocked = await redisCache.get('scraper:lock');
            if (isLocked) {
                logger.info(`🚫 [CRON] Scraper (${label}) skipped — external instance already active (Redis lock held).`);
                return;
            }
        } catch (lockErr) {
            logger.warn(`⚠️ [CRON] Could not check scraper lock: ${lockErr.message}. Proceeding with launch.`);
        }

        this.scraperSchedule.running = true;
        this.scraperSchedule.lastRun = new Date().toISOString();
        
        logger.info(`📡 [CRON] Launching Scraper (${label})...`);
        const proc = spawn('node', [path.join(__dirname, '..', 'SofascoreScraping', 'index.js')], { stdio: 'inherit', windowsHide: true });
        
        proc.on('close', async () => {
            this.scraperSchedule.running = false;
            await redisCache.setLastRun(Date.now()).catch(() => {});
            await redisCache.redis?.del('scraper:lock').catch(() => {}); // Release lock
            logger.info(`✅ [CRON] Scraper (${label}) finished.`);
        });
    }

    async runAdaptiveLearning() {
        try {
            const db = database.db;
            const rows = db.prepare("SELECT * FROM matches WHERE status IN ('FT','Finished') LIMIT 200").all();
            if (rows.length > 0) await adaptiveLearning.processBatch(rows);
        } catch (e) { logger.error(`❌ [CRON] Learning Error: ${e.message}`); }
    }

    async runProactiveEnrichment() {
        try {
            logger.info('🧠 [CRON] Starting proactive 2-day enrichment cycle...');
            const now = Date.now();
            const twoDaysEnd = now + (2 * 24 * 60 * 60 * 1000);
            
            // Get scheduled matches for the next 7 days
            const matches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']);
            const needsEnrichment = matches.filter(m => {
                const ts = m.startTimestamp ? m.startTimestamp * 1000 : (m.timestamp ? new Date(m.timestamp).getTime() : 0);
                const isFuture = ts > now - 3600000 && ts < twoDaysEnd;
                const isStale = !m.home_win_probability || parseFloat(m.home_win_probability) === 0;
                return isFuture && isStale;
            }).slice(0, 300); // 🚀 Increased from 50 to 300 to fulfill the "minimum 50" requirement across all markets

            let filteredNeedsEnrichment = needsEnrichment;
            if (process.env.RAPIDAPI_ENABLED === 'true') {
                const rapidApiQuotaManager = require('./rapidApiQuotaManager');
                const quotaStatus = rapidApiQuotaManager.getQuotaStatus();
                
                if (quotaStatus.remaining <= 0) {
                    logger.warn('🛑 [CRON] Proactive enrichment skipped — RapidAPI quota is exhausted. Running FootballData.io fallback...');
                    try {
                        const footballDataService = require('./footballDataService');
                        await footballDataService.processFallbackFixtures();
                    } catch (fdErr) {
                        logger.error(`❌ [CRON] FootballData fallback failed: ${fdErr.message}`);
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
                
                logger.info(`🧠 [CRON] RapidAPI active: filtered enrichment to ${filteredNeedsEnrichment.length} matches within remaining quota (${quotaStatus.remaining}).`);
            }

            if (filteredNeedsEnrichment.length > 0) {
                logger.info(`🧠 [CRON] Enriching ${filteredNeedsEnrichment.length} future matches...`);
                const enriched = await enrichedPredictions.enrichMatches(filteredNeedsEnrichment);
                for (const m of enriched) {
                    await database.updatePredictions(m.id, m);
                }
                logger.info('✅ [CRON] Proactive enrichment cycle complete.');
            } else {
                logger.info('✅ [CRON] All future matches are already up to date.');
            }
        } catch (e) {
            logger.error(`❌ [CRON] Proactive Enrichment Error: ${e.message}`);
        }
    }
}

module.exports = new CronManager();
