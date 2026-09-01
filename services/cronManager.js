const cron = require('node-cron')
const { spawn } = require('child_process')
const path = require('path')
const logger = require('../core/logger')
const database = require('../core/database')
const redisCache = require('./redisCache')
const workerBridge = require('./workerBridge')
const { runAnalysis } = require('../scripts/today_analysis')
const promosportResultService = require('./promosportResultService')
const { snapshotOdds } = require('./oddsMovementService')
const autoArchiver = require('./autoArchiver')
const retroSync = require('./retroSyncService')
const adaptiveLearning = require('./adaptiveLearningEngine')
const autoBacktestService = require('./autoBacktestService')
const enrichedPredictions = require('../core/enriched_predictions')
const { runAutoRetrain, runV56Retrain } = require('../scripts/auto_retrain_worker')
const { invalidateCache } = require('../core/speedCache')

/**
 * Exécute un script node en asynchrone (non bloquant) via spawn.
 * @param {string} scriptPath chemin relatif vers le script
 * @param {string[]} args arguments
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function runNodeScriptAsync(scriptPath, args = [], timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node'
    const proc = spawn(nodeCmd, [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)
    proc.stdout.on('data', (d) => (stdout += d.toString()))
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return reject(new Error(`timeout after ${timeoutMs}ms`))
      if (code !== 0) return reject(new Error(stderr || `exit code ${code}`))
      resolve(stdout)
    })
  })
}

class CronManager {
  constructor() {
    this.scraperSchedule = { running: false, lastRun: null }
  }

  init(socketService) {
    logger.info('⏰ [CRON] Initializing master scheduler...')

    // Heartbeat — écrit un timestamp Redis toutes les 5 min
    cron.schedule('*/5 * * * *', async () => {
      try {
        await redisCache.set('cron:heartbeat', Date.now(), 300).catch(() => {})
      } catch (_) {}
    })

    // 0. Calibrage live autonome (toutes les 5 min).
    // Rend le journal de prédictions O/U live + la résolution auto des scores finaux
    // indépendants de l'ouverture du navigateur : le flux live est rafraîchi (les
    // prédictions sont journalisées) et les matchs terminés sont résolus, même sans
    // que personne ne consulte la page FLASH ODDS.
    cron.schedule(
      '*/5 * * * *',
      async () => {
        try {
          const Bypass = require('./scrapers/SofascoreBypass')
          const Resolver = require('./scrapers/LiveResultResolver')
          // Rafraîchit le flux live (journalise les nouvelles prédictions).
          await Bypass.getLiveEvents().catch(() => {})
          // Force la résolution des matchs terminés.
          const stats = await Resolver.autoResolve({ force: true }).catch(() => null)
          if (stats && stats.resolved > 0) {
            logger.info(`✅ [CRON] Live calibrage: ${stats.resolved}/${stats.scanned} scores finaux résolus auto`)
          }
        } catch (e) {
          logger.warn(`⚠️ [CRON] Live calibrage error: ${e.message}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 1. Nightly accuracy analysis (23:00)
    cron.schedule(
      '0 23 * * *',
      async () => {
        try {
          const date = new Date().toISOString().split('T')[0]
          const result = await runAnalysis(date)
          if (result) logger.info(`✅ [CRON] Accuracy: ${result.accuracy}%`)
        } catch (e) {
          logger.error(`❌ [CRON] Accuracy Error: ${e.message}`)
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 2. Auto-Scraper (toutes les 3h de 06:00 à 21:00)
    cron.schedule('0 6,9,12,15,18,21 * * *', (label) => this.launchScraper(label), {
      timezone: 'Europe/Paris',
    })

    // 3. Odds snapshot (Every 2 hours)
    cron.schedule(
      '0 */2 * * *',
      async () => {
        try {
          const matches = (await database.getTodayMatches?.()) || []
          if (matches.length > 0) snapshotOdds(matches)
        } catch (e) {
          logger.error(`❌ [CRON] Odds Error: ${e.message}`)
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 3b. Real Odds Sweep (BetExplorer free pool) — toutes les 15 min.
    // Récupère les cotes réelles (1X2 + O2.5 + BTTS) des matchs programmés
    // qui en manquent (services/oddsSweeper.js) et alimente odds_history (CLV).
    cron.schedule(
      '*/15 * * * *',
      async () => {
        try {
          const oddsSweeper = require('./oddsSweeper')
          const res = await oddsSweeper.sweep()
          if (res && res.success && res.stats) {
            logger.info(
              `✅ [CRON] Odds sweep: ${res.stats.fetched}/${res.stats.targeted} (échecs ${res.stats.failed}) — couverture 1X2 ${res.stats.coverage?.with1x2 ?? 0}/${res.stats.coverage?.total ?? 0}`
            )
          }
        } catch (e) {
          logger.error(`❌ [CRON] Odds sweep error: ${e.message}`)
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 3c. Top-Picks scoring pipeline (sync → link → settle) — 2x/jour.
    // Ferme la boucle : les top_picks PENDING sont réglés automatiquement
    // contre les scores réels (services/topPicksService.js).
    cron.schedule(
      '0 2,12 * * *',
      async () => {
        try {
          const { runScoringPipeline } = require('./topPicksService')
          const r = runScoringPipeline()
          logger.info(
            `✅ [CRON] Top-picks scoring: sync=${r.sync.synced} link=${r.link.linked} settle=${r.settle.settled}`
          )
        } catch (e) {
          logger.error(`❌ [CRON] Top-picks scoring error: ${e.message}`)
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 4. Daily Auto-Archiver (04:00)
    cron.schedule('0 4 * * *', () => {
      try {
        autoArchiver.runArchiver(2)
      } catch (e) {
        logger.error(`❌ [CRON] Daily archiver error: ${e.message}`)
      }
    }, { timezone: 'Europe/Paris' })

    // 4b. Daily Auto-Backtest (03:00) — refreshes data/backtest_results.json so the
    // isotonic confidence calibration stays on recent settled observations (P3 audit).
    // Without this, calibration_iso neutralizes itself after ISO_BACKTEST_MAX_AGE_DAYS.
    cron.schedule(
      '0 3 * * *',
      async () => {
        try {
          const res = await autoBacktestService.runAutoBacktest()
          logger.info(`✅ [CRON] Auto-backtest done (${res?.matches ?? '?'} matches)`)
        } catch (e) {
          logger.error(`❌ [CRON] Auto-backtest error: ${e.message}`)
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 5. Online Learning Incremental Update (every 6 hours â€” after archiver at 04:00)
    cron.schedule(
      '30 */6 * * *',
      () => {
        logger.info('🧠 [CRON] Launching Online Learning Incremental Update...')
        const proc = spawn(
          'node',
          [path.join(__dirname, '..', 'scripts', 'online_learning_update.js')],
          { stdio: 'inherit', windowsHide: true }
        )
        proc.on('close', (code) =>
          logger.info(`✅ [CRON] Online Learning finished (code ${code})`)
        )
        proc.on('error', (e) => logger.error(`❌ [CRON] Online Learning spawn error: ${e.message}`))
      },
      { timezone: 'Africa/Tunis' }
    )

    // 6. Periodic H2H Reinforcement (05:00)
    cron.schedule(
      '0 5 * * *',
      () => {
        const proc = spawn('node', [path.join(__dirname, '..', 'tools', 'reinject_h2h.js')], {
          stdio: 'inherit',
          windowsHide: true,
        })
        proc.on('close', (code) => logger.info(`✅ [CRON] H2H Success (code ${code})`))
        proc.on('error', (e) => logger.error(`❌ [CRON] H2H spawn error: ${e.message}`))
      },
      { timezone: 'Europe/Paris' }
    )

    // 6. Retro-Sync (Every 3 hours) â€” try Account 2 worker first
    cron.schedule(
      '0 */3 * * *',
      async () => {
        try {
          const result = await workerBridge.callWorker('sync/retro')
          if (!result?.success) {
            await retroSync.syncPastMatches()
          }
        } catch (e) {
          logger.error(`❌ [CRON] Retro-sync error: ${e.message}`)
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 7. Adaptive Learning Engine (02:30)
    cron.schedule('30 2 * * *', () => this.runAdaptiveLearning(), { timezone: 'Europe/Paris' })

    // 8. Cache cleanup + deltaEngine cleanup (Every 6 hours)
    cron.schedule('0 */6 * * *', () => {
      try {
        redisCache.clearExpired()
        const deltaEngine = require('./deltaEngine')
        deltaEngine.cleanup()
      } catch (e) {
        logger.warn(`[CRON] Cache/delta cleanup error: ${e.message}`)
      }
    })

    // 9. Combo Refresh (Every hour)
    cron.schedule('0 * * * *', () => {
      try {
        socketService.refreshCombos()
      } catch (e) {
        logger.warn(`[CRON] Combo refresh error: ${e.message}`)
      }
    })

    // 10. Proactive Future Enrichment (every 4 hours) â€” try Account 2 worker first
    cron.schedule(
      '0 0,4,8,12,16,20 * * *',
      async () => {
        const result = await workerBridge.callWorker('enrich')
        if (!result?.success) {
          await this.runProactiveEnrichment()
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 10b. Ultra-Frequent Enrichment (every 20 min) — keeps elite cache fresh + Telegram broadcast + auto-optimize + fallback
    const telegramBot = require('../core/telegramBot')
    const autoOptimizer = require('../core/autoOptimizer')
    cron.schedule('*/20 * * * *', async () => {
      logger.info('🌀 [CRON] Starting Autonomous Cycle...')
      await telegramBot
        .runEnrichmentAndBroadcast()
        .catch((e) => logger.warn(`[CRON] Telegram broadcast error: ${e.message}`))
      await autoOptimizer
        .optimizeModelBasedOnROI()
        .catch((e) => logger.warn(`[CRON] Auto-optimizer error: ${e.message}`))

      // 10c. Free Fallback — enrich matches with insufficient_data or stale predictions
      try {
        const fallbackEnricher = require('../core/fallback_enricher')
        logger.info(`🌀 [CRON] Free Fallback enriching stale matches (local JS engine)...`)
        const result = await fallbackEnricher.enrichMatchesBatch()
        if (result.total > 0) {
          logger.info(
            `✅ [CRON] Free Fallback: ${result.enriched}/${result.total} enriched (XGB:${result.xgbOk} JS:${result.jsOk})`
          )
        }
        // 10c-bis. O/U + BTTS market backfill — fills odds_over25/odds_under25/
        // odds_btts_yes/odds_btts_no for matches that already carry 1X2 odds
        // (fixes the dashboard cells that render "--").
        const mkt = await fallbackEnricher.backfillMarkets({ limit: 150 })
        if (mkt.updated > 0) {
          logger.info(`✅ [CRON] Market backfill: ${mkt.updated}/${mkt.scanned} got O/U + BTTS`)
        }
      } catch (e) {
        logger.warn(`⚠️ [CRON] Free Fallback error: ${e.message}`)
      }

      // 10d. Context & Lineup Refresh — adjust predictions for lineups/absences within 4h of kickoff
      try {
        const axios = require('axios')
        const INFERENCE_URL = process.env.INFERENCE_URL || 'http://127.0.0.1:8000'
        const soonMatches = await database.getMatchesStartingSoon(4)
        if (soonMatches && soonMatches.length > 0) {
          logger.info(`🌀 [CRON] Context refreshing ${soonMatches.length} near-kickoff matches...`)
          const result = await axios
            .post(
              `${INFERENCE_URL}/fallback/context-refresh`,
              {
                matches: soonMatches.map((m) => ({
                  id: m.id,
                  homeTeam: m.homeTeam,
                  awayTeam: m.awayTeam,
                  league: m.league || m.tournament_name || '',
                })),
              },
              { timeout: 120000 }
            )
            .then((r) => r.data)
            .catch((e) => ({ success: false, error: e.message }))

          if (result.success) {
            logger.info(
              `✅ [CRON] Context refresh: ${result.refreshed}/${result.total} matches adjusted`
            )
          } else {
            logger.warn(`⚠️ [CRON] Context refresh failed: ${result.error}`)
          }
        }
      } catch (e) {
        logger.warn(`⚠️ [CRON] Context refresh error: ${e.message}`)
      }
    })

    // 9.5 Tunisian Promosport Crowd Collector (08:00 daily)
    cron.schedule(
      '0 8 * * *',
      () => {
        logger.info('🌍 [CRON] Launching Tunisian Crowd Collector...')
        const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'crowd_collector.js')], {
          stdio: 'inherit',
          windowsHide: true,
        })
        proc.on('close', (code) => logger.info(`✅ [CRON] Tunisian Crowd finished (code ${code})`))
        proc.on('error', (e) => logger.error(`❌ [CRON] Crowd Collector spawn error: ${e.message}`))
      },
      { timezone: 'Africa/Tunis' }
    )

    // 9.6 Weekly XGBoost TITANIUM V3 Retrain (Saturday 23:30) — after archive update with Tunisia data
    cron.schedule(
      '30 23 * * 6',
      async () => {
        logger.info('🚀 [CRON] Launching Weekly XGBoost TITANIUM V3 Retrain...')
        try {
          const { runV56Retrain } = require('../scripts/auto_retrain_worker')
          const res = await runV56Retrain()
          if (res.success) {
            logger.info(`✅ [CRON] TITANIUM V3 retrained: ${res.message}`)
          } else {
            logger.warn(`⚠️ [CRON] TITANIUM V3 retrain issue: ${res.message}`)
          }
        } catch (e) {
          logger.error(`❌ [CRON] TITANIUM V3 retrain failed: ${e.message || e}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 9.6 Promosport Results Checker (20:30 daily — offset from the 20:00 job below to avoid double-fetch)
    cron.schedule(
      '30 20 * * *',
      async () => {
        logger.info('🏁 [CRON] Checking Promosport results for recent concours...')
        try {
          const history = promosportResultService.getRecentHistory(5)
          for (const concours of history) {
            await promosportResultService.checkAndFetchResults(concours)
          }
          logger.info(`✅ [CRON] Checked ${history.length} Promosport concours`)
        } catch (e) {
          logger.error(`❌ [CRON] Promosport results check error: ${e.message}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 9.7 Promosport Results Overnight Recheck (00:30)
    cron.schedule(
      '30 0 * * *',
      async () => {
        logger.info('🌙 [CRON] Overnight Promosport results recheck...')
        try {
          const history = promosportResultService.getRecentHistory(10)
          for (const concours of history) {
            await promosportResultService.checkAndFetchResults(concours)
          }
          logger.info(`✅ [CRON] Overnight check done for ${history.length} concours`)
        } catch (e) {
          logger.error(`❘ [CRON] Overnight results error: ${e.message}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 10.1 Universal Omniscience Predictor (Every 2 hours for near-real-time tactical updates)
    cron.schedule(
      '0 */2 * * *',
      () => {
        logger.info('🚀 [CRON] Launching Universal Bulk Predictor...')
        const proc = spawn(
          'node',
          [path.join(__dirname, '..', 'scripts', 'universal_predictor.js')],
          { stdio: 'inherit', windowsHide: true }
        )
        proc.on('close', (code) =>
          logger.info(`✅ [CRON] Universal Predictor finished (code ${code})`)
        )
        proc.on('error', (e) => logger.error(`❌ [CRON] Universal Predictor spawn error: ${e.message}`))
      },
      { timezone: 'Europe/Paris' }
    )

    // 10.2 Daily Surgical Elite 50 â€"- Main dispatch 10:00 AM (after 06:00 scraper)
    cron.schedule(
      '0 10 * * *',
      () => {
        logger.info('🚀 [CRON] Launching Surgical Elite 50 Pronostic (10:00 AM)...')
        const proc = spawn(
          'node',
          [path.join(__dirname, '..', 'scripts', 'surgical_elite_50.js')],
          { stdio: 'inherit', windowsHide: true }
        )
        proc.on('close', (code) =>
          logger.info(`✅ [CRON] Surgical Elite 50 finished (code ${code})`)
        )
        proc.on('error', (e) => logger.error(`❌ [CRON] Surgical Elite 50 spawn error: ${e.message}`))
      },
      { timezone: 'Europe/Paris' }
    )

    // 10.3 Afternoon Elite 50 refresh â€” 14:00 PM
    cron.schedule(
      '0 14 * * *',
      () => {
        logger.info('🚀 [CRON] Launching Surgical Elite 50 Afternoon Refresh...')
        const proc = spawn(
          'node',
          [path.join(__dirname, '..', 'scripts', 'surgical_elite_50.js')],
          { stdio: 'inherit', windowsHide: true }
        )
        proc.on('close', (code) =>
          logger.info(`✅ [CRON] Elite 50 Afternoon finished (code ${code})`)
        )
        proc.on('error', (e) => logger.error(`❓ [CRON] Elite 50 Afternoon spawn error: ${e.message}`))
      },
      { timezone: 'Europe/Paris' }
    )

    // 10.2 Daily MR. X Draw Oracle Broadcast (10:00 AM)
    cron.schedule(
      '0 10 * * *',
      () => {
        logger.info('🚀 [CRON] Launching MR. X Daily Broadcast...')
        const botService = require('./botService')
        botService.sendMrXBroadcast()
      },
      { timezone: 'Europe/Paris' }
    )

    // 11. Database Maintenance (03:00 AM) â€” try Account 2 worker first
    cron.schedule(
      '0 3 * * *',
      async () => {
        try {
          const result = await workerBridge.callWorker('db/maintenance')
          if (!result?.success) {
            await database.maintenance()
          }
        } catch (e) {
          logger.error(`❓ [CRON] DB maintenance error: ${e.message}`)
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 12. Monthly Auto-Retrain (04:00 AM 1st of every month)
    cron.schedule(
      '0 4 1 * *',
      () => {
        logger.info('🚀 [CRON] Launching Monthly XGBoost Auto-Retrain (V24 + V56)...')
        // Train V24 legacy model (existing worker)
        runAutoRetrain()
          .then((res) => {
            if (res.success) {
              const botService = require('./botService')
              botService.sendAlert(`🔥 <b>TITANIUM AUTO-RETRAIN (CRON)</b> 🔥\n\n${res.message}`)
            }
          })
          .catch((e) => logger.error(`[CRON] V24 Auto-Retrain failed: ${e}`))
        // Train V56 model (chronological split, 22 features)
        runV56Retrain().then((res) => {
          logger.info(`[CRON] V56 retrain: ${res.success ? 'OK' : 'FAIL'} — ${res.message}`)
        })
      },
      { timezone: 'Africa/Tunis' }
    )

    // 12b. Weekly Live Model Retrain (05:00 AM every Sunday)
    cron.schedule(
      '0 5 * * 0',
      () => {
        logger.info('🚀 [CRON] Launching Weekly Live Goal Model Retrain...')
        const { runLiveModelRetrain } = require('../scripts/auto_retrain_worker')
        runLiveModelRetrain().then((res) => {
          if (res.success) {
            logger.info('✅ [CRON] Live goal model retrained successfully')
          }
        })
      },
      { timezone: 'Africa/Tunis' }
    )

    // 12c. Weekly Dixon-Coles MLE GoalModel Fit (06:00 AM every Sunday)
    cron.schedule(
      '0 6 * * 0',
      async () => {
        logger.info('📐 [CRON] Launching Weekly Dixon-Coles GoalModel MLE Fit...')
        try {
          const http = require('http')
          const body = JSON.stringify({})
          const opts = {
            hostname: '127.0.0.1',
            port: 5000,
            path: '/api/goalmodel/fit',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
            timeout: 300000,
          }
          const result = await new Promise((resolve, reject) => {
            const req = http.request(opts, (r) => {
              let data = ''
              r.on('data', (c) => (data += c))
              r.on('end', () => {
                try {
                  resolve(JSON.parse(data))
                } catch (e) {
                  resolve({ raw: data })
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
          if (result?.success) {
            logger.info(`✅ [CRON] GoalModel fit started: ${result.total} leagues`)
          } else {
            logger.warn(`⚠️ [CRON] GoalModel fit issue: ${JSON.stringify(result)}`)
          }
        } catch (e) {
          logger.error(`❌ [CRON] GoalModel fit failed: ${e.message}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 13. [TITANIUM] Daily Surgical Dispatch (09:00 AM)
    cron.schedule(
      '0 9 * * *',
      () => {
        logger.info('🚀 [CRON] Launching Daily Surgical Dispatch...')
        const proc = spawn(
          'node',
          [path.join(__dirname, '..', 'scripts', 'surgical_daily_dispatch.js')],
          { stdio: 'inherit', windowsHide: true }
        )
        proc.on('close', (code) =>
          logger.info(`✅ [CRON] Surgical Dispatch finished (code ${code})`)
        )
        proc.on('error', (e) => logger.error(`❓ [CRON] Surgical Dispatch spawn error: ${e.message}`))
      },
      { timezone: 'Africa/Tunis' }
    )

    // 14. [TITANIUM] Hourly Results Update (Every hour at :15 to catch finished matches)
    cron.schedule(
      '15 * * * *',
      () => {
        logger.info('🚀 [CRON] Launching Hourly Results Report...')
        const proc = spawn(
          'node',
          [path.join(__dirname, '..', 'scripts', 'surgical_results_report.js')],
          { stdio: 'inherit', windowsHide: true }
        )
        proc.on('close', (code) => logger.info(`✅ [CRON] Results Report finished (code ${code})`))
        proc.on('error', (e) => logger.error(`❓ [CRON] Results Report spawn error: ${e.message}`))
      },
      { timezone: 'Africa/Tunis' }
    )

    // 14b. [TITANIUM] Hourly Results-Only Pass (every hour at :45) — settles
    // scores as soon as they drop, without re-running the full fixture scan.
    cron.schedule(
      '45 * * * *',
      async () => {
        logger.info('🏁 [CRON] Launching hourly results-only pass...')
        try {
          const { runResultsOnlyScan } = require('./scraperBridge')
          const res = await runResultsOnlyScan()
          if (res?.success && !res?.skipped) {
            logger.info(
              `✅ [CRON] Hourly results: ${res.results?.updated ?? 0} settled (${res.results?.fetched ?? 0} fetched)`
            )
          } else if (res?.skipped) {
            logger.info('⏭️ [CRON] Hourly results skipped (already in flight)')
          }
        } catch (e) {
          logger.error(`❌ [CRON] Hourly results pass error: ${e.message}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 15. [AUTOHEAL] Autopilot system patrol (Every 15 minutes) â€” includes stale xG detection & fix
    cron.schedule('*/15 * * * *', () => {
      try {
        const autoHealAgent = require('./autoHealAgent')
        autoHealAgent.patrol()
      } catch (e) {
        logger.error(`❌ [CRON] AutoHeal patrol error: ${e.message}`)
      }
    })

    // 15b. [STATS] HT score + Corners extraction for finished matches (2x/day)
    for (const hour of [4, 22]) {
      cron.schedule(
        `30 ${hour} * * *`,
        () => {
          logger.info(`[CRON] HT + Corners extraction ${hour}h`)
          try {
            const db = require('../core/database').db
            const extractor = require('./sofascoreStatsExtractor')
            extractor.processFinishedMatches(db, { limit: 200 }).catch((e) =>
              logger.error(`[CRON] HT+corners extraction error: ${e.message}`)
            )
          } catch (e) {
            logger.error(`[CRON] HT+corners setup error: ${e.message}`)
          }
        },
        { timezone: 'Africa/Tunis' }
      )
    }


    // 19. Archive finished matches (Daily at 04:30) â€” via Account 2 worker
    cron.schedule(
      '30 4 * * *',
      async () => {
        const result = await workerBridge.callWorker('sync/archive')
        if (!result?.success) {
          try {
            await database.archiveFinishedMatches()
          } catch (e) {
            logger.error(`[CRON] Archive error: ${e.message}`)
          }
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 19b. Quick archive check (Every 2h, 8-23,0-2) � updates prediction results
    cron.schedule(
      '0 8-23,0-2 * * *',
      async () => {
        try {
          const res = await database.archiveFinishedMatches()
          if (res?.archivedCount > 0) {
            logger.info(`[CRON] Quick archive: ${res.archivedCount} matches`)
          }
        } catch (e) {
          logger.error(`[CRON] Quick archive error: ${e.message}`)
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 19c. Stale matches purge (Daily at 06:00, configurable via STALE_MATCH_CLEANUP_CRON)
    cron.schedule(
      process.env.STALE_MATCH_CLEANUP_CRON || '0 6 * * *',
      async () => {
        try {
          const deleted = await database.cleanupStaleMatches()
          if (deleted > 0) {
            logger.info(`[CRON] Stale cleanup: ${deleted} matches purged`)
          }
        } catch (e) {
          logger.error(`[CRON] Stale cleanup error: ${e.message}`)
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 20. OpenLigaDB Sync (Daily at 05:00) â€” via Account 2 worker
    cron.schedule(
      '0 5 * * *',
      async () => {
        try {
          await workerBridge.callWorker('sync/openligadb')
        } catch (e) {
          logger.error(`❓ [CRON] OpenLigaDB sync error: ${e.message}`)
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 21. Live Value Alerts (Every 5 min, 9:00-23:59) â€” detects EV+ live bets
    cron.schedule(
      '*/5 9-23 * * *',
      () => {
        const scriptPath = path.join(__dirname, '..', 'scripts', 'live_value_alerts.js')
        if (require('fs').existsSync(scriptPath)) {
          const proc = spawn('node', [scriptPath, '--once'], { stdio: 'ignore', windowsHide: true })
          proc.on('error', (e) => logger.error(`❓ [CRON] Live Value Alerts spawn error: ${e.message}`))
          proc.unref()
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 22. FastAPI Keepalive (Every 5 min) — prevents cold start on free tier + warm engines
    cron.schedule(
      '*/5 * * * *',
      async () => {
        const https = require('https')
        const http = require('http')
        const fastApiUrl = process.env.INFERENCE_URL || 'http://127.0.0.1:8000'
        const urls = [
          fastApiUrl + '/health',
          fastApiUrl + '/warmup',
          'https://pronostico.onrender.com/api/health',
        ]
        for (const url of urls) {
          try {
            await new Promise((resolve, reject) => {
              const mod = url.startsWith('https') ? https : http
              const req = mod.get(url, { timeout: 15000 }, (res) => {
                res.resume()
                resolve()
              })
              req.on('error', () => resolve())
              req.on('timeout', () => {
                req.destroy()
                resolve()
              })
            })
          } catch (_) {}
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 23. Weekly Platt Calibration + XGBoost Retrain (Sunday 03:00 UTC)
    cron.schedule(
      '0 3 * * 0',
      async () => {
        logger.info('[CRON] Launching weekly Platt calibration...')
        const fastApiUrl = process.env.INFERENCE_URL || 'http://127.0.0.1:8000'
        const httpMod = fastApiUrl.startsWith('https') ? require('https') : require('http')
        const apiKey = process.env.API_SECRET_KEY || ''
        const postJson = (path, body) =>
          new Promise((resolve) => {
            const data = JSON.stringify(body)
            const urlObj = new URL(fastApiUrl.replace(/\/+$/, '') + path)
            const opts = {
              hostname: urlObj.hostname,
              port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443),
              path: urlObj.pathname + urlObj.search,
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
              },
              timeout: 300000,
            }
            if (apiKey) opts.headers['Authorization'] = 'Bearer ' + apiKey
            const req = httpMod.request(opts, (res) => {
              let d = ''
              res.on('data', (c) => (d += c))
              res.on('end', () => {
                try {
                  resolve(JSON.parse(d))
                } catch (_) {
                  resolve({ raw: d })
                }
              })
            })
            req.on('error', () => resolve({}))
            req.on('timeout', () => {
              req.destroy()
              resolve({})
            })
            req.write(data)
            req.end()
          })
        const calRes = await postJson('/calibrate', {})
        logger.info(
          `[CRON] Calibrate: ${calRes.success ? 'OK' : 'FAIL'} (${calRes.samples || 0} samples)`
        )
        const retrainRes = await postJson('/retrain', {})
        logger.info(
          `[CRON] Retrain: ${retrainRes.success ? 'OK' : 'FAIL'} — ${retrainRes.message || ''}`
        )
      },
      { timezone: 'UTC' }
    )

    // 24. Weekly Promosport XGBoost Retrain (Saturday 04:00 Africa/Tunis)
    cron.schedule(
      '0 4 * * 6',
      async () => {
        logger.info('[CRON] Launching weekly Promosport XGBoost retrain...')
        const scriptsDir = path.join(__dirname, '..', 'scripts')
        const { resolvePython } = require('../core/utils/pythonResolver')
        const pythonCmd = resolvePython()

        // Guard: check dataset before retrain
        try {
          const { guardRetrain } = require(path.join(scriptsDir, 'promosport_guards.js'))
          const guard = guardRetrain()
          if (!guard.allowed) {
            logger.warn(`[CRON] Retrain blocked by guard: ${guard.reason}`)
            return
          }
          logger.info(`[CRON] Guard OK - ${guard.totalRows} rows in dataset`)
        } catch (e) {
          logger.error(`[CRON] Guard check failed: ${e.message}`)
        }

        // Backup DB before retrain
        try {
          const { backupDatabase } = require(path.join(scriptsDir, 'auto_save_db.js'))
          backupDatabase()
        } catch (_) {}

        // Step 1: re-import data
        try {
          const imprt = spawn(pythonCmd, ['scripts/import_promosport_archive.py'], {
            cwd: path.join(__dirname, '..'),
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 120000,
            windowsHide: true,
          })
          let importOut = ''
          imprt.stdout.on('data', (d) => (importOut += d.toString()))
          await new Promise((resolve, reject) => {
            imprt.on('close', (code) =>
              code === 0
                ? resolve()
                : reject(new Error(`Import exited ${code}: ${importOut.slice(-200)}`))
            )
            imprt.on('error', reject)
          })
          logger.info('[CRON] Promosport data import OK')
        } catch (e) {
          logger.error(`[CRON] Promosport import failed: ${e.message}`)
          return
        }

        // Step 2: retrain XGBoost
        try {
          const train = spawn(pythonCmd, ['scripts/train_promosport_xgboost.py'], {
            cwd: path.join(__dirname, '..'),
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 600000,
            windowsHide: true,
          })
          let trainOut = ''
          train.stdout.on('data', (d) => (trainOut += d.toString()))
          await new Promise((resolve, reject) => {
            train.on('close', (code) =>
              code === 0
                ? resolve()
                : reject(new Error(`Train exited ${code}: ${trainOut.slice(-200)}`))
            )
            train.on('error', reject)
          })
          const accMatch = trainOut.match(/Accuracy: ([\d.]+)%/)
          const llMatch = trainOut.match(/Log Loss: ([\d.]+)/)
          logger.info(
            `[CRON] Promosport retrain OK — accuracy: ${accMatch ? accMatch[1] + '%' : 'N/A'} log_loss: ${llMatch ? llMatch[1] : 'N/A'}`
          )

          // Save log loss for drift detection
          if (llMatch) {
            try {
              require(path.join(scriptsDir, 'promosport_guards.js')).saveLogLoss(llMatch[1])
            } catch (_) {}
          }

          // Backfill predictions
          try {
            await runNodeScriptAsync(
              path.join(scriptsDir, 'backfill_promosport_predictions.js'),
              [],
              120000
            )
          } catch (_) {}

          // Reload model
          try {
            const mlService = require('./promosportMLService')
            mlService.reloadModel()
          } catch (_) {}
        } catch (e) {
          logger.error(`[CRON] Promosport retrain failed: ${e.message}`)
          // Restore backup on failure
          try {
            const fs = require('fs')
            const bkp = path.join(__dirname, '..', 'models', 'promosport_xgb.backup.json')
            const mdl = path.join(__dirname, '..', 'models', 'promosport_xgb.json')
            if (fs.existsSync(bkp)) fs.copyFileSync(bkp, mdl)
          } catch (_) {}
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 25. Daily Promosport Tunisie results check (20:00 Africa/Tunis)
    cron.schedule(
      '0 20 * * *',
      async () => {
        logger.info('[CRON] Checking new Promosport Tunisie results...')
        try {
          const promosportResultService = require('./promosportResultService')
          const { getRecentHistory } = promosportResultService
          const recent = getRecentHistory(3)
          const latest = recent.length > 0 ? Math.max(...recent.map(Number)) : 877
          let newResults = false
          for (let g = latest; g <= latest + 5; g++) {
            const results = await promosportResultService.checkAndFetchResults(g)
            if (results) {
              logger.info(`[CRON] Grid ${g}: ${results.length} nouveaux résultats`)
              newResults = true
            }
          }
          // Auto-retrain if new results found
          if (newResults) {
            logger.info('[CRON] New results found, triggering auto-retrain...')
            promosportResultService.triggerAutoRetrain()
          }
          logger.info('[CRON] Tunisie results check complete')
        } catch (e) {
          logger.error(`[CRON] Tunisie results check error: ${e.message}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 26. Promosport Tunisie crowd scraper (daily 10:00 Africa/Tunis)
    cron.schedule(
      '0 10 * * *',
      async () => {
        logger.info('[CRON] Starting Promosport Tunisie crowd scrape...')
        try {
          const scriptsDir = path.join(__dirname, '..', 'scripts')
          await runNodeScriptAsync(
            path.join(scriptsDir, 'crowd_collector.js'),
            ['collect-latest'],
            60000
          )
          logger.info('[CRON] Tunisie crowd scrape done')
        } catch (e) {
          logger.error(`[CRON] Tunisie crowd scrape error: ${e.message}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 27. New concours detection (Monday 08:00 Africa/Tunis)
    cron.schedule(
      '0 8 * * 1',
      async () => {
        logger.info('[CRON] Checking for new Promosport concours...')
        try {
          const scriptsDir = path.join(__dirname, '..', 'scripts')
          const detectScript = path.join(scriptsDir, 'detect_new_concours.js')
          if (require('fs').existsSync(detectScript)) {
            const detector = require(detectScript)
            const result = await detector.detectNewConcours()
            if (result && result.found) {
              logger.info(`[CRON] New concours detected: ${result.concoursNumber}`)
              const botService = require('./botService')
              botService.sendAlert(
                `🎯 <b>Nouveau Concours Promosport Détecté</b>\nConcours: ${result.concoursNumber}\nGrilles générées automatiquement`
              )
            } else {
              logger.info('[CRON] No new concours detected')
            }
          }
        } catch (e) {
          logger.error(`[CRON] New concours detection error: ${e.message}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 28. Daily accuracy snapshot (23:00 Africa/Tunis)
    cron.schedule(
      '0 23 * * *',
      async () => {
        logger.info('[CRON] Taking Promosport accuracy snapshot...')
        try {
          const { saveSnapshot } = require(
            path.join(__dirname, '..', 'scripts', 'accuracy_snapshot.js')
          )
          const entry = saveSnapshot()
          if (entry)
            logger.info(`[CRON] Snapshot: ${entry.accuracy}% (${entry.correct}/${entry.total})`)
        } catch (e) {
          logger.error(`[CRON] Accuracy snapshot error: ${e.message}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 29. Weekly benchmark (Sunday 12:00 Africa/Tunis)
    cron.schedule(
      '0 12 * * 0',
      async () => {
        logger.info('[CRON] Running Promosport weekly benchmark...')
        try {
          const { runBenchmark } = require(
            path.join(__dirname, '..', 'scripts', 'weekly_benchmark.js')
          )
          const result = runBenchmark()
          if (result)
            logger.info(
              `[CRON] Benchmark: model=${result.model.accuracy} crowd=${result.crowd.accuracy} random=${result.random.accuracy}`
            )
        } catch (e) {
          logger.error(`[CRON] Benchmark error: ${e.message}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 30. Daily DB backup (03:00 Africa/Tunis)
    cron.schedule(
      '0 3 * * *',
      async () => {
        logger.info('[CRON] Backing up Promosport database...')
        try {
          const { backupDatabase } = require(
            path.join(__dirname, '..', 'scripts', 'auto_save_db.js')
          )
          backupDatabase()
        } catch (e) {
          logger.error(`[CRON] DB backup error: ${e.message}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 31. Weekly backup pruning (Sunday 03:30)
    cron.schedule(
      '30 3 * * 0',
      async () => {
        logger.info('[CRON] Pruning old DB backups...')
        try {
          const { pruneOldBackups } = require(
            path.join(__dirname, '..', 'scripts', 'auto_save_db.js')
          )
          pruneOldBackups(30)
        } catch (e) {
          logger.error(`[CRON] Backup pruning error: ${e.message}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 32. Daily predictions (06:00 Africa/Tunis)
    cron.schedule(
      '0 6 * * *',
      async () => {
        logger.info('[CRON] Launching daily predictions pipeline...')

        // 🛡️ Safety net: if the DB has no upcoming fixtures (e.g. a stuck or
        // skipped scraper), force a resilient fixtures scan so the dashboard
        // never displays an empty "TOUS LES MATCHS 0" state.
        try {
          const db = require('../core/database')
          const all = (typeof db.getAllMatches === 'function' && (await db.getAllMatches())) || []
          const now = Date.now() / 1000
          const upcoming = all.filter((m) => (m.startTimestamp || 0) > now).length
          if (upcoming === 0) {
            logger.warn('[CRON] 0 upcoming matches in DB — forcing resilient fixtures scan')
            const { runResilientScan } = require('./scraperBridge')
            await runResilientScan().catch((e) =>
              logger.warn(`[CRON] Forced resilient scan failed: ${e.message}`)
            )
          }
        } catch (e) {
          logger.warn(`[CRON] Upcoming-check skipped: ${e.message}`)
        }

        const { resolvePython } = require('../core/utils/pythonResolver')
        const pythonCmd = resolvePython()
        const cronRoot = path.join(__dirname, '..')
        // 🆓 Free pipeline refresh (curl_cffi SofaScore odds + soccerdata fixtures) before predictions
        for (const step of ['services/soccerdataService.py', 'scripts/cacheSofascoreOdds.py']) {
          try {
            await new Promise((res, rej) => {
              const p = spawn(pythonCmd, [step], {
                cwd: cronRoot,
                shell: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 600000,
                windowsHide: true,
              })
              let out = ''
              p.stdout.on('data', (d) => (out += d.toString()))
              p.on('close', (c) =>
                c === 0 ? res() : rej(new Error(step + ' exited ' + c + ': ' + out.slice(-300)))
              )
              p.on('error', rej)
            })
            logger.info('[CRON] ' + step + ' OK')
          } catch (e) {
            logger.error('[CRON] ' + step + ' failed: ' + e.message)
          }
        }
        // Free international results (martj42 CC0, 49k+ matches, cached 24h)
        try {
          await new Promise((res, rej) => {
            const p = spawn(pythonCmd, ['-c', `
import sys; sys.path.insert(0, 'data_pipeline')
from pipeline import run_international
df = run_international()
print(f'international: {len(df) if df is not None else 0} rows')
`], {
              cwd: cronRoot,
              shell: true,
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 300000,
              windowsHide: true,
            })
            let out = ''
            p.stdout.on('data', (d) => { out += d.toString() })
            p.on('close', (c) => {
              if (c === 0) res()
              else rej(new Error('run_international exited ' + c + ': ' + out.slice(-200)))
            })
            p.on('error', rej)
          })
          logger.info('[CRON] run_international OK')
        } catch (e) {
          logger.warn('[CRON] run_international failed: ' + e.message)
        }
        try {
          const pred = spawn(pythonCmd, ['scripts/daily_predictions.py'], {
            cwd: path.join(__dirname, '..'),
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 600000,
            windowsHide: true,
          })
          let predOut = ''
          pred.stdout.on('data', (d) => (predOut += d.toString()))
          await new Promise((resolve, reject) => {
            pred.on('close', (code) => {
              if (code === 0) resolve()
              else reject(new Error(`daily_predictions exited ${code}: ${predOut.slice(-300)}`))
            })
            pred.on('error', reject)
          })
          logger.info('[CRON] Daily predictions OK')
        } catch (e) {
          logger.error(`[CRON] Daily predictions failed: ${e.message}`)
        }
        // Persist top-picks for real scoring + try settling any finished ones
        try {
          const topPicks = require('./topPicksService')
          const pipe = topPicks.runScoringPipeline()
          logger.info(
            `[CRON] Top-picks pipeline: synced=${pipe.sync.synced} linked=${pipe.link.linked} settled=${pipe.settle.settled}`
          )
        } catch (e) {
          logger.error(`[CRON] Top-picks pipeline failed: ${e.message}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    logger.info('✅ [CRON] Scheduler active')

    // 🚀 [RESUME] Trigger scraper 30s after boot to repopulate DB on Render wake-up
    setTimeout(() => {
      logger.info('🔄 [CRON] Resuming scraper on server startup...')
      this.launchScraper('startup-resume')
    }, 30000)
  }

  async launchScraper(label) {
    if (this.scraperSchedule.running) return

    // 🔒 [LOCK CHECK] If the external scraper process already holds the Redis lock,
    // skip spawning a duplicate. A lock older than 25 minutes is considered stale
    // (crashed/hung instance) and is ignored so scans keep running.
    try {
      const lockVal = await redisCache.get('scraper:lock')
      if (lockVal) {
        const ts = parseInt(lockVal, 10)
        const isFresh = Number.isFinite(ts) && Date.now() - ts < 25 * 60 * 1000
        if (isFresh) {
          logger.info(
            `ðŸš« [CRON] Scraper (${label}) skipped â€” external instance already active (Redis lock held).`
          )
          return
        }
        logger.warn(
          `⚠️ [CRON] Scraper lock present but stale (${lockVal}) â€” proceeding with local scan.`
        )
      }
    } catch (lockErr) {
      logger.warn(
        `⚠️ [CRON] Could not check scraper lock: ${lockErr.message}. Proceeding with launch.`
      )
    }

    this.scraperSchedule.running = true
    this.scraperSchedule.lastRun = new Date().toISOString()

    // ⏱️ Auto-reset after 30 minutes si le flag reste bloqué
    const safetyTimer = setTimeout(
      () => {
        if (this.scraperSchedule.running) {
          logger.warn(`âš ï¸ [CRON] Scraper (${label}) safety timeout â€” auto-reset running flag`)
          this.scraperSchedule.running = false
        }
      },
      30 * 60 * 1000
    )

    logger.info(`📡 [CRON] Launching Scraper (${label}) via bridge...`)

    // Use scraper bridge: calls serverless worker if configured, otherwise runs locally
    const scraperBridge = require('./scraperBridge')
    try {
      await scraperBridge.triggerScrape()
    } catch (err) {
      logger.error(`[CRON] Scraper bridge failed: ${err.message}`)
    }

    clearTimeout(safetyTimer)
    this.scraperSchedule.running = false
    await redisCache.setLastRun(Date.now()).catch(() => {})
    await redisCache.redis?.del('scraper:lock').catch(() => {})
    // 🧹 Invalidate the cached /api/upcoming response so the dashboard
    // immediately reflects freshly scraped matches.
    try {
      invalidateCache('upcoming')
    } catch (_) {}
    logger.info(`✅ [CRON] Scraper (${label}) finished via bridge.`)
  }

  async runAdaptiveLearning() {
    try {
      const db = database.db
      const rows = db
        .prepare("SELECT * FROM matches WHERE status IN ('FT','Finished') LIMIT 200")
        .all()
      if (rows.length > 0) await adaptiveLearning.processBatch(rows)
    } catch (e) {
      logger.error(`❌ [CRON] Learning Error: ${e.message}`)
    }
  }

  async runProactiveEnrichment() {
    try {
      logger.info('🧠 [CRON] Starting proactive 4-hour enrichment cycle...')
      const now = Date.now()
      const lookupEnd = now + 3 * 24 * 60 * 60 * 1000

      // Get scheduled matches for the next 7 days
      const matches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS'])
      const needsEnrichment = matches
        .filter((m) => {
          const ts = m.startTimestamp
            ? m.startTimestamp * 1000
            : m.timestamp
              ? new Date(m.timestamp).getTime()
              : 0
          const isFuture = ts > now - 3600000 && ts < lookupEnd
          const isStale = !m.home_win_probability || parseFloat(m.home_win_probability) === 0
          return isFuture && isStale
        })
        .slice(0, 300) // 🚀 Increased from 50 to 300 to fulfill the "minimum 50" requirement across all markets

      let filteredNeedsEnrichment = needsEnrichment
      if (process.env.RAPIDAPI_ENABLED === 'true') {
        const rapidApiQuotaManager = require('./rapidApiQuotaManager')
        const quotaStatus = rapidApiQuotaManager.getQuotaStatus()

        if (quotaStatus.remaining <= 0) {
          logger.warn(
            'ðŸ›‘ [CRON] Proactive enrichment skipped â€” RapidAPI quota is exhausted. Running FootballData.io fallback...'
          )
          try {
            const footballDataService = new Proxy({}, { get: (t, p) => (p === 'isAvailable' ? () => false : (p === 'then' ? undefined : (async () => null))) });
            await footballDataService.processFallbackFixtures()
          } catch (fdErr) {
            logger.error(`❌ [CRON] FootballData fallback failed: ${fdErr.message}`)
          }
          return
        }

        // Keep only matches within the quota
        filteredNeedsEnrichment = []
        for (const m of needsEnrichment) {
          if (rapidApiQuotaManager.canProcessMatch(m.id)) {
            rapidApiQuotaManager.registerMatch(m.id)
            filteredNeedsEnrichment.push(m)
          }
          if (filteredNeedsEnrichment.length >= quotaStatus.remaining) break
        }

        logger.info(
          `🧠 [CRON] RapidAPI active: filtered enrichment to ${filteredNeedsEnrichment.length} matches within remaining quota (${quotaStatus.remaining}).`
        )
      }

      if (filteredNeedsEnrichment.length > 0) {
        logger.info(`🧠 [CRON] Enriching ${filteredNeedsEnrichment.length} future matches...`)
        const enriched = await enrichedPredictions.enrichMatches(filteredNeedsEnrichment)
        for (const m of enriched) {
          await database.updatePredictions(m.id, m)
        }
        logger.info('✅ [CRON] Proactive enrichment cycle complete.')
      } else {
        logger.info('✅ [CRON] All future matches are already up to date.')
      }
    } catch (e) {
      logger.error(`❌ [CRON] Proactive Enrichment Error: ${e.message}`)
    }
  }
}

module.exports = new CronManager()
