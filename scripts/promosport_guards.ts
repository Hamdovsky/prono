// @ts-nocheck
import fs from 'fs'
import path from 'path'
import logger from '../core/logger'

const ARCHIVE_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite')
const MODEL_PATH = path.join(__dirname, '..', 'models', 'promosport_xgb.json')
const BACKUP_PATH = path.join(__dirname, '..', 'models', 'promosport_xgb.backup.json')
const LOGLOSS_PATH = path.join(__dirname, '..', 'models', 'promosport_logloss.txt')

function checkDatasetBeforeRetrain() {
  try {
    import Database from 'better-sqlite3'
    if (!fs.existsSync(ARCHIVE_PATH)) {
      logger.warn('[GUARDS] No archive DB found')
      return { ok: false, reason: 'no_db' }
    }
    const db = new Database(ARCHIVE_PATH, { readonly: true })
    const rows = db
      .prepare(
        `SELECT COUNT(*) as c FROM promosport_archive WHERE result IS NOT NULL AND result != 'N'`
      )
      .get()
    db.close()

    if (!rows || rows.c < 50) {
      logger.warn(`[GUARDS] Dataset too small for retrain: ${rows?.c || 0} rows`)
      return { ok: false, reason: `dataset_too_small:${rows?.c || 0}` }
    }

    return { ok: true, totalRows: rows.c }
  } catch (e) {
    logger.error(`[GUARDS] checkDatasetBeforeRetrain error: ${e.message}`)
    return { ok: false, reason: `error:${e.message}` }
  }
}

function saveLogLoss(logLoss) {
  try {
    fs.writeFileSync(LOGLOSS_PATH, String(logLoss), 'utf8')
    logger.info(`[GUARDS] Log loss saved: ${logLoss}`)
  } catch (_) {}
}

function checkModelHealth() {
  try {
    if (!fs.existsSync(MODEL_PATH)) {
      return { ok: false, reason: 'model_not_found' }
    }
    const stat = fs.statSync(MODEL_PATH)
    if (stat.size < 1000) {
      return { ok: false, reason: 'model_too_small' }
    }
    return { ok: true, sizeKB: (stat.size / 1024).toFixed(1) }
  } catch (e) {
    return { ok: false, reason: `error:${e.message}` }
  }
}

function guardRetrain() {
  const dataset = checkDatasetBeforeRetrain()
  if (!dataset.ok) {
    const reason = dataset.reason || 'unknown'
    logger.warn(`[GUARDS] Retrain blocked: ${reason}`)
    try {
      import botService from '../services/botService'
      botService.sendAlert(
        `⛔ <b>Retrain bloqué</b>\nCause: ${reason}\nLe retrain hebdomadaire est annulé.`
      )
    } catch (_) {}
    return { allowed: false, reason }
  }
  return { allowed: true, totalRows: dataset.totalRows }
}

if (require.main === module) {
  const op = process.argv[2] || 'check'
  if (op === 'check') {
    const health = checkModelHealth()
    const dataset = checkDatasetBeforeRetrain()
    console.log(
      JSON.stringify({ model: health, dataset, allowed: dataset.ok && health.ok }, null, 2)
    )
  } else if (op === 'guard') {
    const result = guardRetrain()
    process.exit(result.allowed ? 0 : 1)
  }
}

export = { checkDatasetBeforeRetrain, checkModelHealth, saveLogLoss, guardRetrain }
