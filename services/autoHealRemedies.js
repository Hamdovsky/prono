const { exec, spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const logger = require('../core/logger')
const { resolvePython } = require('../core/utils/pythonResolver')
const PYTHON = resolvePython()

class AutoHealRemedies {
  constructor() {
    this.remedyHistory = []
  }

  getRegistry() {
    return [
      {
        id: 'python_service_down',
        severity: 'critical',
        description: 'FastAPI inference engine inaccessible',
        check: async () => {
          const url = (process.env.INFERENCE_URL || 'http://127.0.0.1:8000') + '/health'
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
            if (!res.ok) return { detected: true, detail: `HTTP ${res.status}` }
            return { detected: false }
          } catch (e) {
            return { detected: true, detail: e.message }
          }
        },
        fix: async () => {
          const { execSync } = require('child_process')
          const pythonScript = path.join(__dirname, '..', 'core', 'fastapi_server.py')
          if (!fs.existsSync(pythonScript))
            return { success: false, detail: 'fastapi_server.py not found' }
          try {
            try {
              execSync(`${PYTHON} --version`, { stdio: 'ignore', timeout: 5000 })
            } catch (_) {
              return { success: false, detail: `Python not available: ${PYTHON}` }
            }
            if (process.platform === 'win32') {
              exec('netstat -ano | findstr ":8000" | findstr "LISTENING"', (err, stdout) => {
                if (stdout) {
                  const lines = stdout.trim().split('\n')
                  for (const line of lines) {
                    const parts = line.trim().split(/\s+/)
                    const pid = parts[parts.length - 1]
                    if (pid && !isNaN(parseInt(pid))) {
                      exec(`taskkill /f /pid ${pid} 2>nul || echo no process`)
                    }
                  }
                }
              })
              await new Promise((r) => setTimeout(r, 2000))
            }
            const proc = spawn(PYTHON, [pythonScript], {
              cwd: path.join(__dirname, '..'),
              windowsHide: true,
              stdio: 'ignore',
              detached: true,
            })
            proc.on('error', (e) => logger.error(`[AUTOHEAL] Python spawn error: ${e.message}`))
            proc.unref()
            await new Promise((r) => setTimeout(r, 10000))
            const res = await fetch('http://127.0.0.1:8000/health', {
              signal: AbortSignal.timeout(5000),
            })
            if (res.ok) return { success: true, detail: 'FastAPI restarted successfully' }
            return { success: false, detail: 'FastAPI still unreachable after restart' }
          } catch (e) {
            return { success: false, detail: e.message }
          }
        },
      },

      {
        id: 'deepseek_quota_exhausted',
        severity: 'warning',
        description: 'DeepSeek API quota exhausted — AI enrichment degraded',
        check: async () => {
          try {
            const usageFile = path.join(__dirname, '..', 'data', 'deepseek_usage.json')
            if (!fs.existsSync(usageFile)) return { detected: false }
            const data = JSON.parse(fs.readFileSync(usageFile, 'utf8'))
            const limit = parseInt(process.env.DEEPSEEK_MAX_MONTHLY_CALLS || '220')
            if (data.count >= limit)
              return { detected: true, detail: `${data.count}/${limit} used` }
            return { detected: false }
          } catch (e) {
            return { detected: false }
          }
        },
        fix: async () => {
          logger.warn('🤖 [AUTOHEAL] DeepSeek quota exhausted — switching to Groq-only mode')
          if (process.env.GROQ_API_KEY) {
            return { success: true, detail: 'Groq fallback already configured' }
          }
          return {
            success: true,
            detail: 'AI enrichment paused until next month; no Groq fallback key',
          }
        },
      },

      {
        id: 'redis_disconnected',
        severity: 'warning',
        description: 'Redis connection lost — caching degraded to in-memory fallback',
        check: async () => {
          try {
            const redisClient = require('./redisCache')
            if (redisClient.isReady !== false) return { detected: false }
            try {
              const ping = await redisClient.ping?.()
              if (ping === 'PONG') return { detected: false }
            } catch (_) {}
            return { detected: true, detail: 'Redis not ready' }
          } catch (e) {
            return { detected: true, detail: e.message }
          }
        },
        fix: async () => {
          try {
            const redisClient = require('./redisCache')
            if (redisClient.reconnect) redisClient.reconnect()
            else if (redisClient.connect) redisClient.connect().catch(() => {})
            await new Promise((r) => setTimeout(r, 2000))
            return { success: true, detail: 'Redis reconnection triggered' }
          } catch (e) {
            return { success: false, detail: e.message }
          }
        },
      },

      {
        id: 'memory_high',
        severity: 'warning',
        description: 'Process memory usage exceeds safe threshold',
        check: async () => {
          const mem = process.memoryUsage()
          const heapUsedMB = mem.heapUsed / 1024 / 1024
          const heapTotalMB = mem.heapTotal / 1024 / 1024
          const usageRatio = heapUsedMB / heapTotalMB
          if (usageRatio > 0.85 || heapUsedMB > 400) {
            return {
              detected: true,
              detail: `Heap: ${heapUsedMB.toFixed(0)}MB/${heapTotalMB.toFixed(0)}MB (${(usageRatio * 100).toFixed(0)}%)`,
            }
          }
          return { detected: false }
        },
        fix: async () => {
          try {
            if (global.gc) {
              global.gc()
              await new Promise((r) => setTimeout(r, 500))
              const mem = process.memoryUsage()
              const heapMB = mem.heapUsed / 1024 / 1024
              return { success: true, detail: `GC triggered — heap now ${heapMB.toFixed(0)}MB` }
            }
            return {
              success: true,
              detail: 'GC not exposed; no action taken (add --expose-gc flag)',
            }
          } catch (e) {
            return { success: false, detail: e.message }
          }
        },
      },

      {
        id: 'scraper_lock_stuck',
        severity: 'warning',
        description: 'Scraper Redis lock held longer than 2 hours',
        check: async () => {
          try {
            const redisCache = require('./redisCache')
            const lock = await redisCache.get('scraper:lock')
            if (!lock) return { detected: false }
            const age = Date.now() - (typeof lock === 'number' ? lock : Date.now())
            if (age > 7200000)
              return { detected: true, detail: `Lock age: ${(age / 60000).toFixed(0)} min` }
            return { detected: false }
          } catch (e) {
            return { detected: false }
          }
        },
        fix: async () => {
          try {
            const redisCache = require('./redisCache')
            await redisCache.redis?.del('scraper:lock')
            const cronManager = require('./cronManager')
            cronManager.scraperSchedule.running = false
            return { success: true, detail: 'Scraper lock released' }
          } catch (e) {
            return { success: false, detail: e.message }
          }
        },
      },

      {
        id: 'port_conflict',
        severity: 'critical',
        description: 'Target port occupied by another process',
        check: async () => {
          const port = process.env.PORT || 3001
          const cmd =
            process.platform === 'win32'
              ? `netstat -ano | findstr LISTENING | findstr :${port}`
              : `ss -tlnp | grep :${port}`
          return new Promise((resolve) => {
            exec(cmd, (err, stdout) => {
              if (err || !stdout) return resolve({ detected: false })
              const pids = [
                ...new Set(
                  stdout
                    .trim()
                    .split(/\r?\n/)
                    .map((l) => l.trim().split(/\s+/).pop())
                    .filter((p) => p && p !== '0' && parseInt(p) !== process.pid)
                ),
              ]
              if (pids.length > 0)
                return resolve({
                  detected: true,
                  detail: `PID(s): ${pids.join(', ')} on port ${port}`,
                })
              resolve({ detected: false })
            })
          })
        },
        fix: async () => {
          const port = process.env.PORT || 3001
          const cmd =
            process.platform === 'win32'
              ? `netstat -ano | findstr LISTENING | findstr :${port}`
              : `ss -tlnp | grep :${port}`
          return new Promise((resolve) => {
            exec(cmd, (err, stdout) => {
              if (err || !stdout) return resolve({ success: true, detail: 'No conflict found' })
              const pids = [
                ...new Set(
                  stdout
                    .trim()
                    .split(/\r?\n/)
                    .map((l) => l.trim().split(/\s+/).pop())
                    .filter((p) => p && p !== '0')
                ),
              ]
              const killCmd =
                process.platform === 'win32'
                  ? (pid) => `taskkill /F /PID ${pid} /T`
                  : (pid) => `kill -9 ${pid}`
              Promise.all(
                pids.map((pid) => new Promise((r) => exec(killCmd(pid), () => r())))
              ).then(() =>
                setTimeout(
                  () => resolve({ success: true, detail: `Killed PID(s): ${pids.join(', ')}` }),
                  1500
                )
              )
            })
          })
        },
      },

      {
        id: 'database_bloat',
        severity: 'info',
        description: 'Database maintenance needed (stale predictions, bloat)',
        check: async () => {
          try {
            const database = require('../core/database')
            const staleCount = database.db
              .prepare(
                "SELECT COUNT(*) as c FROM matches WHERE status IN ('scheduled','NS') AND home_win_probability IS NULL"
              )
              .get().c
            if (staleCount > 500)
              return { detected: true, detail: `${staleCount} stale un-enriched matches` }
            return { detected: false }
          } catch (e) {
            return { detected: false }
          }
        },
        fix: async () => {
          try {
            const database = require('../core/database')
            database.maintenance()
            return { success: true, detail: 'Database maintenance triggered' }
          } catch (e) {
            return { success: false, detail: e.message }
          }
        },
      },

      {
        id: 'therundown_api_down',
        severity: 'info',
        description: 'TheRundown odds API inaccessible',
        check: async () => {
          try {
            const tr = require('./therundownService')
            if (!tr.enabled) return { detected: false }
            const status = tr.getQuotaStatus()
            if (status.authFailed && status.quotaExhausted)
              return { detected: true, detail: 'Auth failed or quota exhausted' }
            const data = await tr._fetch('/sports')
            if (!data) return { detected: true, detail: 'No response from API' }
            return { detected: false }
          } catch (e) {
            return { detected: true, detail: e.message }
          }
        },
        fix: async () => {
          const tr = require('./therundownService')
          tr._authFailed = false
          tr._quotaExhausted = false
          return { success: true, detail: 'TheRundown flags reset — will retry on next call' }
        },
      },

      {
        id: 'oddspapi_api_down',
        severity: 'info',
        description: 'OddsPapi odds API inaccessible',
        check: async () => {
          try {
            const svc = require('./oddspapiService')
            if (!svc.enabled) return { detected: false }
            const data = await svc.fetchTournaments(10)
            if (!Array.isArray(data)) return { detected: true, detail: 'No response from API' }
            return { detected: false }
          } catch (e) {
            return { detected: false }
          }
        },
        fix: async () => {
          const svc = require('./oddspapiService')
          svc._authFailed = false
          svc._quotaExhausted = false
          return { success: true, detail: 'OddsPapi flags reset — will retry on next call' }
        },
      },

      {
        id: 'supabase_db_down',
        severity: 'warning',
        description: 'Supabase PostgreSQL connection lost',
        check: async () => {
          try {
            const svc = require('./supabaseService')
            if (!svc.enabled) return { detected: false }
            if (!svc.connected) return { detected: true, detail: 'Supabase not connected' }
            const r = await svc.query('SELECT 1')
            if (!r) return { detected: true, detail: 'Query failed' }
            return { detected: false }
          } catch (e) {
            return { detected: false }
          }
        },
        fix: async () => {
          const svc = require('./supabaseService')
          svc.connected = false
          const ok = await svc.connect()
          return { success: ok, detail: ok ? 'Reconnected' : 'Failed to reconnect' }
        },
      },

      {
        id: 'apifootball_api_down',
        severity: 'info',
        description: 'API-Football (API-Sports) inaccessible',
        check: async () => {
          try {
            const svc = require('./apifootballService')
            if (!svc.enabled) return { detected: false }
            const data = await svc._fetch('/status')
            if (!data) return { detected: true, detail: 'No response from API' }
            return { detected: false }
          } catch (e) {
            return { detected: false }
          }
        },
        fix: async () => {
          const svc = require('./apifootballService')
          svc._authFailed = false
          svc._quotaExhausted = false
          return { success: true, detail: 'APIFootball flags reset — will retry on next call' }
        },
      },

      {
        id: 'sportmonks_api_down',
        severity: 'info',
        description: 'Sportmonks football API inaccessible',
        check: async () => {
          try {
            const svc = require('./sportmonksService')
            if (!svc.enabled) return { detected: false }
            const data = await svc._fetch('/fixtures/upcoming/markets/1?per_page=1')
            if (!data) return { detected: true, detail: 'No response from API' }
            return { detected: false }
          } catch (e) {
            return { detected: false }
          }
        },
        fix: async () => {
          const svc = require('./sportmonksService')
          svc._authFailed = false
          svc._quotaExhausted = false
          return { success: true, detail: 'Sportmonks flags reset — will retry on next call' }
        },
      },

      {
        id: 'bigballsdata_api_down',
        severity: 'info',
        description: 'Big Balls Data API inaccessible',
        check: async () => {
          try {
            const svc = require('./bigBallsDataService')
            if (!svc.enabled) return { detected: false }
            const sports = await svc.getSports()
            if (!sports || sports.length === 0)
              return { detected: true, detail: 'No response from API' }
            return { detected: false }
          } catch (e) {
            return { detected: false }
          }
        },
        fix: async () => {
          const svc = require('./bigBallsDataService')
          svc._authFailed = false
          svc._quotaExhausted = false
          return { success: true, detail: 'BigBallsData flags reset' }
        },
      },

      {
        id: 'oddsapiio_api_down',
        severity: 'info',
        description: 'Odds-API.io inaccessible',
        check: async () => {
          try {
            const svc = require('./oddsApiIoService')
            if (!svc.enabled) return { detected: false }
            const events = await svc.getEvents('football', 'live', 1)
            if (events === null) return { detected: true, detail: 'No response from API' }
            return { detected: false }
          } catch (e) {
            return { detected: false }
          }
        },
        fix: async () => {
          const svc = require('./oddsApiIoService')
          svc._quotaExhausted = false
          return { success: true, detail: 'OddsAPIio flags reset' }
        },
      },

      {
        id: 'predixsport_api_down',
        severity: 'info',
        description: 'PredixSport API inaccessible',
        check: async () => {
          try {
            const svc = require('./predixSportService')
            if (!svc.enabled) return { detected: false }
            const matches = await svc.fetchUpcoming(1)
            if (!Array.isArray(matches)) return { detected: true, detail: 'No response from API' }
            return { detected: false }
          } catch (e) {
            return { detected: false }
          }
        },
        fix: async () => {
          const svc = require('./predixSportService')
          svc._authFailed = false
          svc._quotaExhausted = false
          return { success: true, detail: 'PredixSport flags reset — will retry on next call' }
        },
      },

      {
        id: 'stale_xg_data',
        severity: 'warning',
        description: 'Matches with stale xG (<0.5) from old fatigue bug — need re-enrich',
        check: async () => {
          try {
            const database = require('../core/database')
            const stale = database.db
              .prepare(
                "SELECT COUNT(*) as c FROM matches WHERE status IN ('scheduled','NS') AND home_xg IS NOT NULL AND home_xg > 0.1 AND home_xg < 0.5"
              )
              .get()
            if (stale.c > 0)
              return { detected: true, detail: `${stale.c} matches with stale xG (<0.5)` }
            return { detected: false }
          } catch (e) {
            return { detected: false }
          }
        },
        fix: async () => {
          try {
            const database = require('../core/database')
            const enrichedPredictions = require('../core/enriched_predictions')
            const stale = database.db
              .prepare(
                "SELECT * FROM matches WHERE status IN ('scheduled','NS') AND home_xg IS NOT NULL AND home_xg > 0.1 AND home_xg < 0.5"
              )
              .all()
            const enriched = await enrichedPredictions.enrichMatches(stale, {
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
            return { success: true, detail: `Re-enriched ${updated}/${stale.length} stale matches` }
          } catch (e) {
            return { success: false, detail: e.message }
          }
        },
      },

      {
        id: 'error_log_burst',
        severity: 'warning',
        description: 'High error rate detected in logs',
        check: async () => {
          try {
            const logDir = path.join(__dirname, '..', 'logs')
            const errorFile = path.join(logDir, 'error.log')
            if (!fs.existsSync(errorFile)) return { detected: false }
            const stat = fs.statSync(errorFile)
            const age = Date.now() - stat.mtimeMs
            const sizeMB = stat.size / 1024 / 1024
            if (age < 300000 && sizeMB > 5) {
              return {
                detected: true,
                detail: `Error log: ${sizeMB.toFixed(1)}MB written in last ${(age / 1000).toFixed(0)}s`,
              }
            }
            return { detected: false }
          } catch (e) {
            return { detected: false }
          }
        },
        fix: async () => {
          try {
            const logDir = path.join(__dirname, '..', 'logs')
            const errorFile = path.join(logDir, 'error.log')
            if (fs.existsSync(errorFile)) {
              const backup = path.join(logDir, `error_burst_${Date.now()}.log`)
              fs.renameSync(errorFile, backup)
            }
            return { success: true, detail: 'Error log rotated to prevent disk full' }
          } catch (e) {
            return { success: false, detail: e.message }
          }
        },
      },

      // RAM Usage Monitor
      {
        id: 'ram_usage_high',
        severity: 'warning',
        description: 'High RAM usage detected',
        check: async () => {
          const RAM_WARNING_THRESHOLD = 400 // MB
          const RAM_CRITICAL_THRESHOLD = 450 // MB

          const memUsage = process.memoryUsage()
          const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024)
          const rssMB = Math.round(memUsage.rss / 1024 / 1024)

          const isCritical = rssMB > RAM_CRITICAL_THRESHOLD
          const isWarning = rssMB > RAM_WARNING_THRESHOLD

          if (isCritical) {
            return {
              detected: true,
              detail: `CRITICAL: RAM ${rssMB}MB (heap: ${heapUsedMB}MB) exceeds ${RAM_CRITICAL_THRESHOLD}MB`,
            }
          }

          if (isWarning) {
            return {
              detected: true,
              detail: `WARNING: RAM ${rssMB}MB (heap: ${heapUsedMB}MB) exceeds ${RAM_WARNING_THRESHOLD}MB`,
            }
          }

          return { detected: false, detail: `RAM usage normal: ${rssMB}MB` }
        },
        fix: async () => {
          try {
            const memBefore = process.memoryUsage()
            const rssBeforeMB = Math.round(memBefore.rss / 1024 / 1024)

            // Force garbage collection if available
            if (global.gc) {
              logger.info('🧹 [AUTOHEAL] Running manual garbage collection...')
              global.gc()
            }

            // Clear speed cache
            try {
              const { invalidateAll } = require('../core/speedCache')
              invalidateAll()
              logger.info('🧹 [AUTOHEAL] Speed cache cleared')
            } catch (e) {
              // Speed cache might not be available
            }

            // Wait for GC to complete
            await new Promise((resolve) => setTimeout(resolve, 1000))

            const memAfter = process.memoryUsage()
            const rssAfterMB = Math.round(memAfter.rss / 1024 / 1024)
            const savedMB = rssBeforeMB - rssAfterMB

            if (savedMB > 0) {
              return {
                success: true,
                detail: `RAM freed: ${savedMB}MB (${rssBeforeMB}MB → ${rssAfterMB}MB)`,
              }
            } else {
              return {
                success: false,
                detail: `No RAM freed (${rssBeforeMB}MB → ${rssAfterMB}MB). Consider restarting.`,
              }
            }
          } catch (err) {
            return { success: false, detail: `RAM cleanup failed: ${err.message}` }
          }
        },
      },
    ]
  }

  logRemedy(remedyId, result) {
    this.remedyHistory.push({
      id: remedyId,
      result,
      timestamp: new Date().toISOString(),
    })
    if (this.remedyHistory.length > 100) this.remedyHistory.shift()
  }

  getHistory() {
    return this.remedyHistory
  }
}

module.exports = new AutoHealRemedies()
