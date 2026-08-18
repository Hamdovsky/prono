// @ts-nocheck
import logger from './logger'

function scheduleDailyReport() {
  const now = new Date()
  const target = new Date()
  target.setUTCHours(7, 0, 0, 0)
  if (target <= now) target.setDate(target.getDate() + 1)
  const delay = target.getTime() - now.getTime()
  setTimeout(async () => {
    try {
      import { execSync } from 'child_process'
      const report = execSync('node scripts/daily_health_report.js', {
        timeout: 30000,
        encoding: 'utf-8',
      })
      logger.info('[HEALTH] Daily report:\n' + report.slice(-500))
    } catch (e) {
      logger.warn(`[HEALTH] Daily report failed: ${e.message}`)
    }
    scheduleDailyReport()
  }, delay)
}

function scheduleDailyBackup() {
  const now = new Date()
  const target = new Date()
  target.setUTCHours(3, 0, 0, 0)
  if (target <= now) target.setDate(target.getDate() + 1)
  const delay = target.getTime() - now.getTime()
  setTimeout(async () => {
    try {
      import { execSync } from 'child_process'
      const result = execSync('node scripts/auto_backup_db.js', {
        timeout: 60000,
        encoding: 'utf-8',
      })
      logger.info('[BACKUP] Daily backup:\n' + result.slice(-300))
    } catch (e) {
      logger.warn(`[BACKUP] Daily backup failed: ${e.message}`)
    }
    scheduleDailyBackup()
  }, delay)
}

function scheduleWeeklyRetrain() {
  const now = new Date()
  const target = new Date()
  target.setUTCHours(4, 0, 0, 0)
  const daysUntilSunday = (7 - target.getDay()) % 7 || 7
  target.setDate(target.getDate() + daysUntilSunday)
  if (target <= now) target.setDate(target.getDate() + 7)
  const delay = target.getTime() - now.getTime()
  setTimeout(async () => {
    try {
      import { execSync } from 'child_process'
      const result = execSync('node scripts/auto_retrain_worker.js', {
        timeout: 300000,
        encoding: 'utf-8',
      })
      logger.info('[AUTO-RETRAIN] Weekly retrain:\n' + result.slice(-500))
    } catch (e) {
      logger.warn(`[AUTO-RETRAIN] Weekly retrain failed: ${e.message}`)
    }
    scheduleWeeklyRetrain()
  }, delay)
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
  setTimeout(async () => {
    try {
      import { runAutoBacktest } from '../services/autoBacktestService'
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
}

function init() {
  scheduleDailyReport()
  scheduleDailyBackup()
  scheduleWeeklyRetrain()
  scheduleDailyAutoBacktest()
}

export = { init }
