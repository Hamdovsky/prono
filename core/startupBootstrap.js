const path = require('path')
const fs = require('fs')
const logger = require('./logger')
const database = require('./database')

const DATA_DIR = path.join(__dirname, '..', 'data')

async function downloadFile(url, destPath, { gunzip = false, label = 'file' } = {}) {
  const https = require('https')
  const tmp = destPath + '.download'
  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(tmp)
      https
        .get(url, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`))
            return
          }
          if (gunzip) {
            const zlib = require('zlib')
            res.pipe(zlib.createGunzip()).pipe(file)
          } else {
            res.pipe(file)
          }
          file.on('finish', () => {
            file.close()
            resolve()
          })
        })
        .on('error', reject)
    })
    fs.renameSync(tmp, destPath)
    const sizeMB = (fs.statSync(destPath).size / 1024 / 1024).toFixed(1)
    logger.info(`[BOOT] ${label} downloaded (${sizeMB} MB)`)
  } catch (e) {
    logger.warn(`[BOOT] ${label} download failed: ${e.message}`)
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
}

async function downloadArchive() {
  const archivePath = path.join(DATA_DIR, 'historical_archive.sqlite')
  if (fs.existsSync(archivePath)) {
    const sizeMB = (fs.statSync(archivePath).size / 1024 / 1024).toFixed(1)
    logger.info(`[BOOT] Archive found locally (${sizeMB} MB)`)
    return
  }
  const url = process.env.ARCHIVE_DOWNLOAD_URL || ''
  if (!url) {
    logger.info('[BOOT] ARCHIVE_DOWNLOAD_URL not set — skipping')
    return
  }
  await downloadFile(url, archivePath, { gunzip: true, label: 'historical_archive.sqlite' })
}

async function downloadPremiumCSV() {
  const csvPath = path.join(DATA_DIR, 'v553_wc2026_premium.csv')
  if (fs.existsSync(csvPath)) {
    const sizeMB = (fs.statSync(csvPath).size / 1024 / 1024).toFixed(1)
    logger.info(`[BOOT] Premium CSV found locally (${sizeMB} MB)`)
    return
  }
  const url = process.env.PREMIUM_CSV_URL || ''
  if (!url) {
    logger.info('[BOOT] PREMIUM_CSV_URL not set — skipping')
    return
  }
  await downloadFile(url, csvPath, { label: 'v553_wc2026_premium.csv' })
}

function importPromosport() {
  const importScript = path.join(__dirname, '..', 'scripts', 'import_promosport_archive.py')
  if (!fs.existsSync(importScript)) return
  try {
    const { spawn } = require('child_process')
    const py = spawn('python3', [importScript], {
      cwd: path.join(__dirname, '..'),
      stdio: 'ignore',
      timeout: 120000,
    })
    py.on('close', (code) => {
      if (code === 0) logger.info('[BOOT] Promosport archive import OK')
      else logger.warn(`[BOOT] Promosport import exited ${code}`)
    })
    py.on('error', () => logger.warn('[BOOT] Promosport import skipped (python3 not found)'))
  } catch (_) {}
}

async function warmThetaOptimizer() {
  try {
    const thetaOptimizer = require('../services/thetaOptimizer')
    await thetaOptimizer.optimize()
    logger.info('[BOOT] Theta optimizer calibrated')
  } catch (e) {
    logger.warn(`[BOOT] Theta init: ${e.message}`)
  }
  try {
    const { calibrate } = require('../services/leagueCalibrator')
    calibrate().catch(() => {})
  } catch (e) {
    logger.warn(`[BOOT] Calibrator init: ${e.message}`)
  }
}

async function syncBSD() {
  try {
    const bsd = require('../services/bsdService')
    if (bsd.isAvailable()) {
      logger.info('[BOOT] BSD API available — syncing fixtures...')
      const n = await bsd.fullSync()
      logger.info(`[BOOT] BSD sync complete: ${n} matches`)
    }
  } catch (e) {
    logger.warn(`[BOOT] BSD sync skipped: ${e.message}`)
  }
}

async function syncFootballData() {
  const fdKey = process.env.FOOTBALLDATA_KEY || ''
  if (!fdKey || fdKey.startsWith('CHANGER_MOI')) return
  try {
    const https = require('https')
    const today = new Date().toISOString().split('T')[0]
    const url = `https://api.football-data.org/v4/competitions/WC/matches?dateFrom=${today}&dateTo=${today}`
    logger.info('[BOOT] Fetching WC2026 data from Football-Data.org...')
    const body = await new Promise((resolve, reject) => {
      https
        .get(url, { headers: { 'X-Auth-Token': fdKey } }, (res) => {
          let d = ''
          res.on('data', (c) => (d += c))
          res.on('end', () => resolve(d))
        })
        .on('error', reject)
    })
    const data = JSON.parse(body)
    const matches = data.matches || []
    logger.info(`[BOOT] Football-Data: ${matches.length} WC2026 matches today`)
    for (const m of matches) {
      const home = m.homeTeam.name
      const away = m.awayTeam.name
      const score = m.score?.fullTime || {}
      const status = m.status
      try {
        const existing = database.db
          ?.prepare(
            'SELECT id, fullData FROM matches WHERE homeTeam = ? AND awayTeam = ? AND DATE(timestamp) = ? LIMIT 1'
          )
          .get(home, away, today)
        if (existing) {
          const fd = JSON.parse(existing.fullData || '{}')
          fd.footballData = { score, status, competition: 'WC', matchId: m.id }
          database.db
            ?.prepare('UPDATE matches SET fullData = ? WHERE id = ?')
            .run(JSON.stringify(fd), existing.id)
        }
      } catch (_) {}
    }
    logger.info('[BOOT] Football-Data sync done')
  } catch (e) {
    logger.warn(`[BOOT] Football-Data sync failed: ${e.message}`)
  }
}

async function runCloudSeed() {
  try {
    const { runCloudSeed: seedFn } = require('../core/cloudSeed')
    await seedFn()
    database.cleanupPlaceholderTeams()
    logger.info('[BOOT] Cloud seed OK')
  } catch (e) {
    logger.warn(`[BOOT] Cloud seed error: ${e.message}`)
  }
}

async function emergencyReseed() {
  try {
    // Ensure migration completed before checking count
    if (database._migrationDone) await database._migrationDone
    const result = await database.query('SELECT COUNT(*) as cnt FROM matches')
    const count = parseInt(result?.rows?.[0]?.cnt || result?.[0]?.cnt || 0)
    if (count >= 10) {
      logger.info(`[BOOT] DB OK: ${count} matches`)
      return
    }
    logger.warn(`[BOOT] DB has only ${count} matches — re-seeding in 30s...`)
    await new Promise((resolve) => setTimeout(resolve, 30000))
    await syncBSD()
    await runCloudSeed()
  } catch (e) {
    logger.warn(`[BOOT] Emergency re-seed check failed: ${e.message}`)
  }
}

function killProcessOnPort(port) {
  const { exec } = require('child_process')
  return new Promise((resolve) => {
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
      logger.warn(
        `[PORT] Port ${port} occupied by PID(s) [${[...pidsToKill].join(', ')}]. Releasing...`
      )
      const kills = [...pidsToKill].map(
        (pid) => new Promise((r) => exec(`taskkill /F /PID ${pid} /T`, () => r()))
      )
      Promise.all(kills).then(() => setTimeout(resolve, 1200))
    })
  })
}

async function runAll({ port, onStartServices }) {
  const TIMEOUT = 90_000 // 90s max for full bootstrap
  const bail = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Bootstrap timeout')), TIMEOUT)
  )

  try {
    await Promise.race([
      (async () => {
        await killProcessOnPort(port)
        await new Promise((resolve) => setTimeout(resolve, 500))

        // Ensure PG schema migration completes before any DB operations
        if (database._migrationDone) {
          logger.info('[BOOT] Waiting for PG schema migration...')
          const ok = await database._migrationDone
          logger.info(`[BOOT] PG schema migration ${ok ? 'OK' : 'FAILED'}`)
        }

        try {
          const { redis } = require('./redisClient')
          if (redis) {
            redis
              .ping()
              .then(() => logger.info('[BOOT] Redis connected'))
              .catch(() => logger.warn('[BOOT] Redis not reachable'))
          }
        } catch (_) {}

        await Promise.allSettled([downloadArchive(), downloadPremiumCSV()])
        importPromosport()
        await Promise.allSettled([warmThetaOptimizer(), syncBSD(), syncFootballData()])
        await runCloudSeed()
        await emergencyReseed()
      })(),
      bail,
    ])
  } catch (e) {
    logger.warn(`[BOOT] ${e.message} — continuing with partial initialization`)
  }

  logger.info('[BOOT] Startup bootstrap complete')
}

module.exports = {
  runAll,
  downloadArchive,
  downloadPremiumCSV,
  importPromosport,
  warmThetaOptimizer,
  syncBSD,
  syncFootballData,
  runCloudSeed,
  emergencyReseed,
  killProcessOnPort,
}
