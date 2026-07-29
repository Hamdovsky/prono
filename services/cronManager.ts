// @ts-nocheck
import cron from 'node-cron'
import {  spawn  } from 'child_process'
import path from 'path'
import logger from '../core/logger'
import database from '../core/database'
import redisCache from './redisCache'
import workerBridge from './workerBridge'
import {  runAnalysis  } from '../scripts/today_analysis'
import promosportResultService from './promosportResultService'
import {  snapshotOdds  } from './oddsMovementService'
import autoArchiver from './autoArchiver'
import retroSync from './retroSyncService'
import adaptiveLearning from './adaptiveLearningEngine'
import enrichedPredictions from '../core/enriched_predictions'
import {  runAutoRetrain, runV56Retrain  } from '../scripts/auto_retrain_worker'
import {  invalidateCache  } from '../core/speedCache'

class CronManager {
  constructor() {
    this.scraperSchedule = { running: false, lastRun: null }
  }

  init(socketService) {
    logger.info('⏰ [CRON] Initializing master scheduler...')

    // Heartbeat � �crit un timestamp Redis toutes les 5 min
    cron.schedule('*/5 * * * *', async () => {
      try {
        await redisCache.set('cron:heartbeat', Date.now(), 300).catch(() => {})
      } catch (_) {}
    })

    // 1. Nightly accuracy analysis (23:00)
    cron.schedule(
      '0 23 * * *',
      async () => {
        try {
          const date = new Date().toISOString().split('T')[0]
          const result = await runAnalysis(date)
          if (result) logger.info(`? [CRON] Accuracy: ${result.accuracy}%`)
        } catch (e) {
          logger.error(`? [CRON] Accuracy Error: ${e.message}`)
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

    // 4. Daily Auto-Archiver (04:00)
    cron.schedule('0 4 * * *', () => autoArchiver.runArchiver(2), { timezone: 'Europe/Paris' })

    // 5. Online Learning Incremental Update (every 6 hours — after archiver at 04:00)
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
      },
      { timezone: 'Europe/Paris' }
    )

    // 6. Retro-Sync (Every 3 hours) — try Account 2 worker first
    cron.schedule(
      '0 */3 * * *',
      async () => {
        const result = await workerBridge.callWorker('sync/retro')
        if (!result?.success) {
          await retroSync.syncPastMatches()
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 7. Adaptive Learning Engine (02:30)
    cron.schedule('30 2 * * *', () => this.runAdaptiveLearning(), { timezone: 'Europe/Paris' })

    // 8. Cache cleanup + deltaEngine cleanup (Every 6 hours)
    cron.schedule('0 */6 * * *', () => {
      redisCache.clearExpired()
      import deltaEngine from './deltaEngine'
      deltaEngine.cleanup()
    })

    // 9. Combo Refresh (Every hour)
    cron.schedule('0 * * * *', () => socketService.refreshCombos())

    // 10. Proactive Future Enrichment (every 4 hours) — try Account 2 worker first
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

    // 10b. Ultra-Frequent Enrichment (every 20 min) � keeps elite cache fresh + Telegram broadcast + auto-optimize + fallback
    import telegramBot from '../core/telegramBot'
    import autoOptimizer from '../core/autoOptimizer'
    cron.schedule('*/20 * * * *', async () => {
      logger.info('?? [CRON] Starting Autonomous Cycle...')
      await telegramBot
        .runEnrichmentAndBroadcast()
        .catch((e) => logger.warn(`[CRON] Telegram broadcast error: ${e.message}`))
      await autoOptimizer
        .optimizeModelBasedOnROI()
        .catch((e) => logger.warn(`[CRON] Auto-optimizer error: ${e.message}`))

      // 10c. Free Fallback � enrich matches with insufficient_data or stale predictions
      try {
        import fallbackEnricher from '../core/fallback_enricher'
        logger.info(`?? [CRON] Free Fallback enriching stale matches (local JS engine)...`)
        const result = await fallbackEnricher.enrichMatchesBatch()
        if (result.total > 0) {
          logger.info(
            `? [CRON] Free Fallback: ${result.enriched}/${result.total} enriched (XGB:${result.xgbOk} JS:${result.jsOk})`
          )
        }
      } catch (e) {
        logger.warn(`?? [CRON] Free Fallback error: ${e.message}`)
      }

      // 10d. Context & Lineup Refresh � adjust predictions for lineups/absences within 4h of kickoff
      try {
        import axios from 'axios'
        const INFERENCE_URL = process.env.INFERENCE_URL || 'http://127.0.0.1:8000'
        const soonMatches = await database.getMatchesStartingSoon(4)
        if (soonMatches && soonMatches.length > 0) {
          logger.info(`?? [CRON] Context refreshing ${soonMatches.length} near-kickoff matches...`)
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
              `? [CRON] Context refresh: ${result.refreshed}/${result.total} matches adjusted`
            )
          } else {
            logger.warn(`?? [CRON] Context refresh failed: ${result.error}`)
          }
        }
      } catch (e) {
        logger.warn(`?? [CRON] Context refresh error: ${e.message}`)
      }
    })

    // 9.5 Tunisian Promosport Crowd Collector (08:00 daily)
    cron.schedule(
      '0 8 * * *',
      () => {
        logger.info('?? [CRON] Launching Tunisian Crowd Collector...')
        const proc = spawn('node', [path.join(__dirname, '..', 'scripts', 'crowd_collector.js')], {
          stdio: 'inherit',
          windowsHide: true,
        })
        proc.on('close', (code) => logger.info(`? [CRON] Tunisian Crowd finished (code ${code})`))
      },
      { timezone: 'Africa/Tunis' }
    )

    // 9.6 Weekly XGBoost TITANIUM V3 Retrain (Saturday 23:30) � after archive update with Tunisia data
    cron.schedule(
      '30 23 * * 6',
      async () => {
        logger.info('?? [CRON] Launching Weekly XGBoost TITANIUM V3 Retrain...')
        try {
          import {  runV56Retrain  } from '../scripts/auto_retrain_worker'
          const res = await runV56Retrain()
          if (res.success) {
            logger.info(`? [CRON] TITANIUM V3 retrained: ${res.message}`)
          } else {
            logger.warn(`?? [CRON] TITANIUM V3 retrain issue: ${res.message}`)
          }
        } catch (e) {
          logger.error(`? [CRON] TITANIUM V3 retrain failed: ${e.message || e}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 9.6 Promosport Results Checker (20:00 daily, after matches finish)
    cron.schedule(
      '0 20 * * *',
      async () => {
        logger.info('?? [CRON] Checking Promosport results for recent concours...')
        try {
          const history = promosportResultService.getRecentHistory(5)
          for (const concours of history) {
            await promosportResultService.checkAndFetchResults(concours)
          }
          logger.info(`? [CRON] Checked ${history.length} Promosport concours`)
        } catch (e) {
          logger.error(`? [CRON] Promosport results check error: ${e.message}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    // 9.7 Promosport Results Overnight Recheck (00:30)
    cron.schedule(
      '30 0 * * *',
      async () => {
        logger.info('?? [CRON] Overnight Promosport results recheck...')
        try {
          const history = promosportResultService.getRecentHistory(10)
          for (const concours of history) {
            await promosportResultService.checkAndFetchResults(concours)
          }
          logger.info(`? [CRON] Overnight check done for ${history.length} concours`)
        } catch (e) {
          logger.error(`| [CRON] Overnight results error: ${e.message}`)
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
      },
      { timezone: 'Europe/Paris' }
    )

    // 10.2 Daily Surgical Elite 50 — Main dispatch 10:00 AM (after 06:00 scraper)
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
      },
      { timezone: 'Europe/Paris' }
    )

    // 10.3 Afternoon Elite 50 refresh — 14:00 PM
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
      },
      { timezone: 'Europe/Paris' }
    )

    // 10.2 Daily MR. X Draw Oracle Broadcast (10:00 AM)
    cron.schedule(
      '0 10 * * *',
      () => {
        logger.info('🚀 [CRON] Launching MR. X Daily Broadcast...')
        import botService from './botService'
        botService.sendMrXBroadcast()
      },
      { timezone: 'Europe/Paris' }
    )

    // 11. Database Maintenance (03:00 AM) — try Account 2 worker first
    cron.schedule(
      '0 3 * * *',
      async () => {
        const result = await workerBridge.callWorker('db/maintenance')
        if (!result?.success) {
          await database.maintenance()
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 12. Monthly Auto-Retrain (04:00 AM 1st of every month)
    cron.schedule(
      '0 4 1 * *',
      () => {
        logger.info('?? [CRON] Launching Monthly XGBoost Auto-Retrain (V24 + V56)...')
        // Train V24 legacy model (existing worker)
        runAutoRetrain()
          .then((res) => {
            if (res.success) {
              import botService from './botService'
              botService.sendAlert(`?? <b>TITANIUM AUTO-RETRAIN (CRON)</b> ??\n\n${res.message}`)
            }
          })
          .catch((e) => logger.error(`[CRON] V24 Auto-Retrain failed: ${e}`))
        // Train V56 model (chronological split, 22 features)
        runV56Retrain().then((res) => {
          logger.info(`[CRON] V56 retrain: ${res.success ? 'OK' : 'FAIL'} � ${res.message}`)
        })
      },
      { timezone: 'Africa/Tunis' }
    )

    // 12b. Weekly Live Model Retrain (05:00 AM every Sunday)
    cron.schedule(
      '0 5 * * 0',
      () => {
        logger.info('🚀 [CRON] Launching Weekly Live Goal Model Retrain...')
        import {  runLiveModelRetrain  } from '../scripts/auto_retrain_worker'
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
          import http from 'http'
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
      },
      { timezone: 'Africa/Tunis' }
    )

    // 15. [AUTOHEAL] Autopilot system patrol (Every 15 minutes) — includes stale xG detection & fix
    cron.schedule('*/15 * * * *', () => {
      try {
        import autoHealAgent from './autoHealAgent'
        autoHealAgent.patrol()
      } catch (e) {
        logger.error(`❌ [CRON] AutoHeal patrol error: ${e.message}`)
      }
    })

    // 16. PredixSport Sync (Every 6 hours) — try Account 2 worker first
    cron.schedule(
      '0 */6 * * *',
      async () => {
        const result = await workerBridge.callWorker('sync/predixsport')
        if (!result?.success) {
          try {
            import predixSportService from './predixSportService'
            await predixSportService.syncUpcoming()
          } catch (e) {
            logger.error(`[CRON] PredixSport sync error: ${e.message}`)
          }
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 17. Big Balls Data Sync (Every 12 hours) — try Account 2 worker first
    cron.schedule(
      '0 */12 * * *',
      async () => {
        const result = await workerBridge.callWorker('sync/bigballsdata')
        if (!result?.success) {
          try {
            import bbs from './bigBallsDataService'
            await bbs.syncUpcoming()
          } catch (e) {
            logger.error(`[CRON] BBS sync error: ${e.message}`)
          }
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 18. BSD Sync (Every 6 hours) — via Account 2 worker
    cron.schedule(
      '0 */6 * * *',
      async () => {
        const result = await workerBridge.callWorker('sync/bsd')
        if (!result?.success) {
          logger.info('[CRON] BSD sync skipped — no local fallback available')
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 19. Archive finished matches (Daily at 04:30) — via Account 2 worker
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

    // 19b. Quick archive check (Every 2h, 8-23,0-2) ? updates prediction results
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

    // 20. OpenLigaDB Sync (Daily at 05:00) — via Account 2 worker
    cron.schedule(
      '0 5 * * *',
      async () => {
        await workerBridge.callWorker('sync/openligadb')
      },
      { timezone: 'Europe/Paris' }
    )

    // 21. Live Value Alerts (Every 5 min, 9:00-23:59) — detects EV+ live bets
    cron.schedule(
      '*/5 9-23 * * *',
      () => {
        const scriptPath = path.join(__dirname, '..', 'scripts', 'live_value_alerts.js')
        if (require('fs').existsSync(scriptPath)) {
          const proc = spawn('node', [scriptPath, '--once'], { stdio: 'ignore', windowsHide: true })
          proc.unref()
        }
      },
      { timezone: 'Europe/Paris' }
    )

    // 22. FastAPI Keepalive (Every 5 min) � prevents cold start on free tier + warm engines
    cron.schedule(
      '*/5 * * * *',
      async () => {
        import https from 'https'
        const fastApiUrl = process.env.INFERENCE_URL || 'https://prono-fastapi.onrender.com'
        const urls = [
          fastApiUrl + '/health',
          fastApiUrl + '/warmup',
          'https://prono-scraper.onrender.com/health',
        ]
        for (const url of urls) {
          try {
            await new Promise((resolve, reject) => {
              const req = https.get(url, { timeout: 15000 }, (res) => {
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
        import https from 'https'
        const fastApiUrl = process.env.INFERENCE_URL || 'https://prono-fastapi.onrender.com'
        const apiKey = process.env.API_SECRET_KEY || ''
        const postJson = (path, body) =>
          new Promise((resolve) => {
            const data = JSON.stringify(body)
            const urlObj = new URL(fastApiUrl.replace(/\/+$/, '') + path)
            const opts = {
              hostname: urlObj.hostname,
              port: 443,
              path: urlObj.pathname,
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
              },
              timeout: 300000,
            }
            if (apiKey) opts.headers['Authorization'] = 'Bearer ' + apiKey
            const req = https.request(opts, (res) => {
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
          `[CRON] Retrain: ${retrainRes.success ? 'OK' : 'FAIL'} � ${retrainRes.message || ''}`
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
        import {  resolvePython  } from '../core/utils/pythonResolver'
        const pythonCmd = resolvePython()

        // Guard: check dataset before retrain
        try {
          import {  guardRetrain  } from path.join(scriptsDir, 'promosport_guards.js')
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
          import {  backupDatabase  } from path.join(scriptsDir, 'auto_save_db.js')
          backupDatabase()
        } catch (_) {}

        // Step 1: re-import data
        try {
          const imprt = spawn(pythonCmd, ['scripts/import_promosport_archive.py'], {
            cwd: path.join(__dirname, '..'),
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 120000,
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
            `[CRON] Promosport retrain OK � accuracy: ${accMatch ? accMatch[1] + '%' : 'N/A'} log_loss: ${llMatch ? llMatch[1] : 'N/A'}`
          )

          // Save log loss for drift detection
          if (llMatch) {
            try {
              require(path.join(scriptsDir, 'promosport_guards.js')).saveLogLoss(llMatch[1])
            } catch (_) {}
          }

          // Backfill predictions
          try {
            const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node'
            execSync(
              `${nodeCmd} "${path.join(scriptsDir, 'backfill_promosport_predictions.js')}"`,
              { timeout: 120000, encoding: 'utf8' }
            )
          } catch (_) {}

          // Reload model
          try {
            import mlService from './promosportMLService'
            mlService.reloadModel()
          } catch (_) {}
        } catch (e) {
          logger.error(`[CRON] Promosport retrain failed: ${e.message}`)
          // Restore backup on failure
          try {
            import fs from 'fs'
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
          import promosportResultService from './promosportResultService'
          const { getRecentHistory } = promosportResultService
          const recent = getRecentHistory(3)
          const latest = recent.length > 0 ? Math.max(...recent.map(Number)) : 877
          let newResults = false
          for (let g = latest; g <= latest + 5; g++) {
            const results = await promosportResultService.checkAndFetchResults(g)
            if (results) {
              logger.info(`[CRON] Grid ${g}: ${results.length} nouveaux r�sultats`)
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
          import {  execSync  } from 'child_process'
          const scriptsDir = path.join(__dirname, '..', 'scripts')
          const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node'
          execSync(`${nodeCmd} "${path.join(scriptsDir, 'crowd_collector.js')}" collect-latest`, {
            timeout: 60000,
            encoding: 'utf8',
          })
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
            import detector from detectScript
            const result = await detector.detectNewConcours()
            if (result && result.found) {
              logger.info(`[CRON] New concours detected: ${result.concoursNumber}`)
              import botService from './botService'
              botService.sendAlert(
                `?? <b>Nouveau Concours Promosport D�tect�</b>\nConcours: ${result.concoursNumber}\nGrilles g�n�r�es automatiquement`
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
          import {  saveSnapshot  } from 
            path.join(__dirname, '..', 'scripts', 'accuracy_snapshot.js'
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
          import {  runBenchmark  } from 
            path.join(__dirname, '..', 'scripts', 'weekly_benchmark.js'
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
          import {  backupDatabase  } from 
            path.join(__dirname, '..', 'scripts', 'auto_save_db.js'
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
          import {  pruneOldBackups  } from 
            path.join(__dirname, '..', 'scripts', 'auto_save_db.js'
          )
          pruneOldBackups(30)
        } catch (e) {
          logger.error(`[CRON] Backup pruning error: ${e.message}`)
        }
      },
      { timezone: 'Africa/Tunis' }
    )

    logger.info('✅ [CRON] Scheduler active')

    // ?? [RESUME] Trigger scraper 30s after boot to repopulate DB on Render wake-up
    setTimeout(() => {
      logger.info('?? [CRON] Resuming scraper on server startup...')
      this.launchScraper('startup-resume')
    }, 30000)
  }

  async launchScraper(label) {
    if (this.scraperSchedule.running) return

    // 🔒 [LOCK CHECK] If the external scraper process already holds the Redis lock,
    // skip spawning a duplicate.
    try {
      const isLocked = await redisCache.get('scraper:lock')
      if (isLocked) {
        logger.info(
          `🚫 [CRON] Scraper (${label}) skipped — external instance already active (Redis lock held).`
        )
        return
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
          logger.warn(`⚠️ [CRON] Scraper (${label}) safety timeout — auto-reset running flag`)
          this.scraperSchedule.running = false
        }
      },
      30 * 60 * 1000
    )

    logger.info(`📡 [CRON] Launching Scraper (${label}) via bridge...`)

    // Use scraper bridge: calls serverless worker if configured, otherwise runs locally
    import scraperBridge from './scraperBridge'
    try {
      await scraperBridge.triggerScrape()
    } catch (err) {
      logger.error(`[CRON] Scraper bridge failed: ${err.message}`)
    }

    clearTimeout(safetyTimer)
    this.scraperSchedule.running = false
    await redisCache.setLastRun(Date.now()).catch(() => {})
    await redisCache.redis?.del('scraper:lock').catch(() => {})
    // ?? Invalidate the cached /api/upcoming response so the dashboard
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
        import rapidApiQuotaManager from './rapidApiQuotaManager'
        const quotaStatus = rapidApiQuotaManager.getQuotaStatus()

        if (quotaStatus.remaining <= 0) {
          logger.warn(
            '🛑 [CRON] Proactive enrichment skipped — RapidAPI quota is exhausted. Running FootballData.io fallback...'
          )
          try {
            import footballDataService from './footballDataService'
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

export = new CronManager()
