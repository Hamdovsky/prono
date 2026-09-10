const logger = require('../core/logger')

// execSync (audit 2026-09-10) : backup 60 s / report 30 s / retrain 300 s
// gelaient l'event loop du serveur HTTP -> health checks Render timeoutés.
// Tout passe par spawn async, mêmes logs/tailles/échecs soft qu'avant.
function runScriptAsync(scriptFile, { timeoutMs, tailChars = 500 }) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process')
    const proc = spawn(process.execPath, [scriptFile], { windowsHide: true })
    let out = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`timeout ${timeoutMs}ms on ${scriptFile}`))
    }, timeoutMs)
    timer.unref()
    proc.stdout.on('data', (d) => {
      out += d
    })
    proc.stderr.on('data', (d) => {
      out += d
    })
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.slice(-tailChars))
      else reject(new Error(`exit ${code}: ${out.slice(-200)}`))
    })
  })
}

function scheduleDailyReport() {
  const now = new Date()
  const target = new Date()
  target.setUTCHours(7, 0, 0, 0)
  if (target <= now) target.setDate(target.getDate() + 1)
  const delay = target.getTime() - now.getTime()
  const t = setTimeout(async () => {
    try {
      const report = await runScriptAsync('scripts/daily_health_report.js', {
        timeoutMs: 30000,
        tailChars: 500,
      })
      logger.info('[HEALTH] Daily report:\n' + report)
    } catch (e) {
      logger.warn(`[HEALTH] Daily report failed: ${e.message}`)
    }
    scheduleDailyReport()
  }, delay)
  t.unref()
}

function scheduleDailyBackup() {
  const now = new Date()
  const target = new Date()
  target.setUTCHours(3, 0, 0, 0)
  if (target <= now) target.setDate(target.getDate() + 1)
  const delay = target.getTime() - now.getTime()
  const t = setTimeout(async () => {
    try {
      const result = await runScriptAsync('scripts/auto_backup_db.js', {
        timeoutMs: 60000,
        tailChars: 300,
      })
      logger.info('[BACKUP] Daily backup:\n' + result)
    } catch (e) {
      logger.warn(`[BACKUP] Daily backup failed: ${e.message}`)
    }
    scheduleDailyBackup()
  }, delay)
  t.unref()
}

function scheduleWeeklyRetrain() {
  const now = new Date()
  const target = new Date()
  target.setUTCHours(4, 0, 0, 0)
  const daysUntilSunday = (7 - target.getDay()) % 7 || 7
  target.setDate(target.getDate() + daysUntilSunday)
  if (target <= now) target.setDate(target.getDate() + 7)
  const delay = target.getTime() - now.getTime()
  const t = setTimeout(async () => {
    try {
      const result = await runScriptAsync('scripts/auto_retrain_worker.js', {
        timeoutMs: 300000,
        tailChars: 500,
      })
      logger.info('[AUTO-RETRAIN] Weekly retrain:\n' + result)
    } catch (e) {
      logger.warn(`[AUTO-RETRAIN] Weekly retrain failed: ${e.message}`)
    }
    scheduleWeeklyRetrain()
  }, delay)
  t.unref()
}

function runIsotonicCalibration() {
  return new Promise((resolve) => {
    try {
      const { spawn } = require('child_process')
      const path = require('path')
      const fs = require('fs')
      let pythonPath = 'python'
      const venvPythonPath = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
      if (fs.existsSync(venvPythonPath)) pythonPath = venvPythonPath
      const script = path.join(__dirname, 'calibration_iso.py')
      const proc = spawn(pythonPath, [script, '--fit'], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
      })
      proc.stdout.on('data', (d) => logger.info('[ISO-CAL] ' + d.toString().trim()))
      proc.stderr.on('data', (d) => logger.warn('[ISO-CAL-WARN] ' + d.toString().trim()))
      proc.on('close', (code) => {
        logger.info(`[ISO-CAL] Isotonic fit ${code === 0 ? 'OK' : `exit ${code}`}`)
        resolve(code === 0)
      })
      proc.on('error', (e) => {
        logger.warn(`[ISO-CAL] Could not run isotonic fit: ${e.message}`)
        resolve(false)
      })
    } catch (e) {
      logger.warn(`[ISO-CAL] Could not run isotonic fit: ${e.message}`)
      resolve(false)
    }
  })
}

function scheduleDailyAutoBacktest() {
  const now = new Date()
  const target = new Date()
  target.setUTCHours(2, 30, 0, 0) // 02:30 UTC daily
  if (target <= now) target.setDate(target.getDate() + 1)
  const delay = target.getTime() - now.getTime()
  const t = setTimeout(async () => {
    try {
      const { runAutoBacktest } = require('./autoBacktestService')
      const result = await runAutoBacktest()
      logger.info(
        '[AUTO-BACKTEST] Daily result:\n' +
          JSON.stringify(result?.overall || {}, null, 2).slice(0, 500)
      )
      // Recalibrage isotonique des confiances 1X2 dès que le backtest a régénéré
      // les brackets — sinon le modèle reste sur sa carte précédente.
      await runIsotonicCalibration()
    } catch (e) {
      logger.warn(`[AUTO-BACKTEST] Failed: ${e.message}`)
    }
    scheduleDailyAutoBacktest()
  }, delay)
  t.unref()
}

function init() {
  scheduleDailyReport()
  scheduleDailyBackup()
  scheduleWeeklyRetrain()
  scheduleDailyAutoBacktest()
}

module.exports = { init }
