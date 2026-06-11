const { Pool } = require('pg')
const logger = require('./logger')

let pool = null
let isPostgres = false

function getPool() {
  if (pool) return pool

  // Accept DATABASE_URL or SUPABASE_URL (single source of truth)
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_URL
  if (!dbUrl) {
    logger.info('[PG] No DATABASE_URL/SUPABASE_URL — using SQLite fallback')
    isPostgres = false
    return null
  }

  isPostgres = true

  const isSupabase = dbUrl.includes('supabase.co')
  pool = new Pool({
    connectionString: dbUrl,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    ssl: isSupabase ? { rejectUnauthorized: false } : undefined,
    allowExitOnIdle: false
  })

  pool.on('error', (err) => {
    logger.error(`[PG] Unexpected pool error: ${err.message}`)
  })

  pool.on('acquire', () => {
    logger.debug('[PG] Connection acquired from pool')
  })

  logger.info(`[PG] Connected to Postgres via connection pool (max: 5)`)
  return pool
}

function usingPostgres() {
  return isPostgres
}

async function query(text, params = []) {
  const p = getPool()
  if (!p) return { rows: [], error: 'No Postgres config' }

  const start = Date.now()
  try {
    const result = await p.query(text, params)
    const duration = Date.now() - start
    if (duration > 500) {
      logger.warn(`[PG SLOW QUERY] ${duration}ms — ${text.slice(0, 80)}`)
    }
    return { rows: result.rows, rowCount: result.rowCount }
  } catch (err) {
    logger.error(`[PG QUERY] ${err.message} — ${text.slice(0, 120)}`)
    throw err
  }
}

async function endPool() {
  if (pool) {
    await pool.end()
    pool = null
    isPostgres = false
    logger.info('[PG] Pool closed')
  }
}

async function healthCheck() {
  if (!isPostgres) return { ok: false, reason: 'SQLite' }
  try {
    const result = await query('SELECT 1 AS ok')
    return { ok: result.rows.length > 0, poolSize: pool?.totalCount || 0, idleCount: pool?.idleCount || 0 }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

module.exports = { getPool, usingPostgres, query, endPool, healthCheck }
