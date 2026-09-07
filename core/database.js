const path = require('path')
const fs = require('fs')
const logger = require('./logger')
const {
  applyMarketPolicy,
  deriveBttsPick,
  deriveCornerPick,
  deriveHTPick,
} = require('./marketPolicy')
const { applyLeaguePolicy } = require('./leaguePolicy')

// 🚀 [DB TOGGLE] If DATABASE_URL is set, use Neon PostgreSQL directly — skip SQLite entirely
if (process.env.DATABASE_URL) {
  logger.info('[DB] DATABASE_URL detected — using Postgres (Neon/Supabase) instead of SQLite')
  const pgConnector = require('./pg_connector')
  const pgDb = require('./pg_database')
  const pgMigrations = require('./pg_migrations')
  pgConnector.getPool()
  const migrationPromise = pgMigrations.runMigrations()
  migrationPromise.catch((e) => logger.error(`[DB] PG migration error: ${e.message}`))
  // Backfill startTimestamp from "fullData" for existing rows
  setTimeout(async () => {
    try {
      const { query: pgQuery } = require('./pg_connector')
      const testResult = await pgQuery(
        'SELECT id, "fullData", SUBSTRING("fullData" FROM \'"startTimestamp":([0-9]+)\') AS ts FROM matches WHERE "startTimestamp" IS NULL AND "fullData" IS NOT NULL LIMIT 1'
      )
      if (testResult.rows.length > 0) {
        const testRow = testResult.rows[0]
        logger.info(
          `[DB] Backfill test: id=${testRow.id} ts_extracted=${testRow.ts} fullData_length=${(testRow.fullData || '').length}`
        )
        if (testRow.ts) {
          const result = await pgQuery(
            `UPDATE matches SET "startTimestamp" = SUBSTRING("fullData" FROM '"startTimestamp":([0-9]+)')::bigint WHERE "startTimestamp" IS NULL AND "fullData" IS NOT NULL AND "fullData" ~ '"startTimestamp":[0-9]+'`
          )
          logger.info(`[DB] Backfill result: rowCount=${result.rowCount}`)
        } else {
          logger.warn('[DB] Backfill: could not extract startTimestamp')
        }
      } else {
        logger.info('[DB] Backfill: no rows need backfill')
      }
    } catch (e) {
      logger.warn(`[DB] Backfill error: ${e.message}`)
    }
  }, 5000)
  // Load league model parameters into StatisticalEngine from PG (if available)
  setTimeout(async () => {
    try {
      const { query: pgQuery } = require('./pg_connector')
      const lmResult = await pgQuery('SELECT * FROM league_model_parameters').catch(() => ({
        rows: [],
      }))
      if (lmResult.rows && lmResult.rows.length > 0) {
        const paramsMap = {}
        for (const row of lmResult.rows) {
          const key = (row.tournament_name || '').toLowerCase().trim()
          if (key && row.team_name) {
            paramsMap[key] = paramsMap[key] || { rho: -0.12, gamma: 0.0 }
          }
        }
        const StatisticalEngine = require('./services/StatisticalEngine')
        StatisticalEngine.loadGoalModelParams(paramsMap)
        logger.info(
          `[DB] Loaded ${lmResult.rows.length} league model parameters into StatisticalEngine`
        )
      }
    } catch (e) {
      logger.warn(`[DB] Could not load league model params: ${e.message}`)
    }
  }, 10000)
  pgDb._migrationDone = migrationPromise.then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await pgConnector.query('SELECT 1 FROM matches LIMIT 1')
        return true
      } catch {
        if (attempt < 2) {
          logger.warn(
            `[DB] matches table not found (attempt ${attempt + 1}) — retrying migration...`
          )
          await new Promise((r) => setTimeout(r, 5000))
          const retry = await pgMigrations.runMigrations()
          if (retry.applied > 0 || retry.skipped) continue
        }
      }
    }
    logger.error('[DB] matches table creation failed after 3 attempts')
    return false
  })
  module.exports = pgDb
  return
}

// ── SQLite initialization (only reached when DATABASE_URL is NOT set) ──
let db = null
// SQLITE_DB_PATH overrides the default DB for tests (see __tests__/db-isolation.js),
// so `npm run test` never touches the production data/tactical.db.
const dbPath = process.env.SQLITE_DB_PATH
  ? path.resolve(process.env.SQLITE_DB_PATH)
  : path.resolve(__dirname, '../data/tactical.db')
try {
  const Database = require('better-sqlite3')
  const dbDir = path.dirname(dbPath)
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 30000')
  db.pragma('cache_size = -16000')
  db.pragma('temp_store = MEMORY')
  db.pragma('mmap_size = 64000000')
  db.pragma('wal_autocheckpoint = 1000')
  db.pragma('foreign_keys = ON')
  logger.info('[DB] SQLite initialized')
} catch (e) {
  logger.warn(`[DB] SQLite not available: ${e.message}.`)
}

// Periodic WAL checkpoint (no-op if SQLite unavailable)
const WAL_CHECKPOINT_INTERVAL = 5 * 60 * 1000
const _walTimer = setInterval(() => {
  try {
    if (db) db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch (_) {}
}, WAL_CHECKPOINT_INTERVAL)
_walTimer.unref()

if (db) logger.info(`🗄️ [DATABASE] Using SQLite: ${dbPath}`)

// ── Split 2026-09-07 : schéma, helpers SQL et DAOs vivent dans core/db/* ──
const { initSchema, runMigrations, seedLeaguesConfig } = require('./db/schema')
const { createQueryHelpers } = require('./db/query')
const { createMatchesDao } = require('./db/matches')
const { createPredictionsDao } = require('./db/predictions')
const { createMiscDao } = require('./db/misc')

initSchema(db)
runMigrations(db)
seedLeaguesConfig(db)

const queryHelpers = createQueryHelpers(db)

const database = {
  db,
  ...queryHelpers,
  ...createMatchesDao(db),
  ...createPredictionsDao(db),
  ...createMiscDao(db),
}

// 🛡️ [DATABASE SELF-HEALING]
// Removed redundant maintenance interval - handled by CronManager at 3 AM.

database.db.query = database.query.bind(database)
module.exports = database
