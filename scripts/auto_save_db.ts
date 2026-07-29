// @ts-nocheck
import fs from 'fs'
import path from 'path'
import logger from '../core/logger'

const DB_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite')
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups')

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
  }
}

function backupDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    logger.warn('[AUTO-SAVE] No database found at', DB_PATH)
    return null
  }
  ensureBackupDir()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(BACKUP_DIR, `historical_archive_${timestamp}.sqlite`)
  fs.copyFileSync(DB_PATH, backupPath)
  logger.info(`[AUTO-SAVE] Database backed up: ${backupPath}`)
  return backupPath
}

function pruneOldBackups(maxAgeDays = 30) {
  ensureBackupDir()
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.sqlite'))
  const now = Date.now()
  let pruned = 0
  for (const file of files) {
    const filePath = path.join(BACKUP_DIR, file)
    const stat = fs.statSync(filePath)
    const ageDays = (now - stat.mtimeMs) / (1000 * 60 * 60 * 24)
    if (ageDays > maxAgeDays) {
      fs.unlinkSync(filePath)
      pruned++
    }
  }
  if (pruned > 0) logger.info(`[AUTO-SAVE] Pruned ${pruned} old backups (>${maxAgeDays} days)`)
  return pruned
}

if (require.main === module) {
  const op = process.argv[2] || 'backup'
  if (op === 'prune') {
    pruneOldBackups()
  } else {
    backupDatabase()
    pruneOldBackups()
  }
}

export = { backupDatabase, pruneOldBackups }
