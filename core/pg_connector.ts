import { Pool, QueryResult } from 'pg'
import logger from './logger'

let pool: Pool | null = null
let isPostgres = false

function getPool(): Pool | null {
  if (pool) return pool

  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_URL
  if (!dbUrl) {
    logger.info('[PG] No DATABASE_URL/SUPABASE_URL — using SQLite fallback')
    isPostgres = false
    return null
  }

  isPostgres = true

  const isSupabase = dbUrl.includes('supabase.co') || dbUrl.includes('neon.tech')
  pool = new Pool({
    connectionString: dbUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    ssl: isSupabase ? { rejectUnauthorized: false } : undefined,
    allowExitOnIdle: false,
  })

  pool.on('error', (err: Error) => {
    logger.error(`[PG] Unexpected pool error: ${err.message}`)
  })

  setInterval(async () => {
    try {
      await pool!.query('SELECT 1')
    } catch (_) {
      /* ignore keep-alive failures */
    }
  }, 120000).unref()

  logger.info(`[PG] Connected to Postgres via connection pool (max: 5)`)
  return pool
}

function usingPostgres(): boolean {
  return isPostgres
}

const permissionErrors = new Set<string>()

async function query(
  text: string,
  params: unknown[] = [],
  retries = 1
): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null; error?: string }> {
  const p = getPool()
  if (!p) return { rows: [], error: 'No Postgres config' }

  const start = Date.now()
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result: QueryResult = await p.query(text, params)
      const duration = Date.now() - start
      if (duration > 500) {
        logger.warn(`[PG SLOW QUERY] ${duration}ms — ${text.slice(0, 80)}`)
      }
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount }
    } catch (err: unknown) {
      const msg = (err as Error).message || ''
      const isTimeout =
        msg.includes('timeout') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('Connection terminated') ||
        msg.includes('write EPIPE')
      if (isTimeout && attempt < retries) {
        logger.warn(`[PG QUERY RETRY] attempt ${attempt + 1}/${retries} — ${msg}`)
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      const isPermissionErr =
        msg.includes('doit être le propriétaire') ||
        msg.includes('droit refusé') ||
        msg.includes('permission denied') ||
        msg.includes('must be owner')
      if (isPermissionErr) {
        const key = msg.slice(0, 60)
        if (!permissionErrors.has(key)) {
          permissionErrors.add(key)
          logger.warn(`[PG PERMISSION] ${msg} — (suppressed for this session)`)
        }
      } else {
        logger.error(`[PG QUERY] ${msg} — ${text.slice(0, 120)}`)
      }
      throw err
    }
  }
}

async function endPool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
    isPostgres = false
    logger.info('[PG] Pool closed')
  }
}

async function healthCheck(): Promise<{
  ok: boolean
  reason?: string
  poolSize?: number
  idleCount?: number
}> {
  if (!isPostgres) return { ok: false, reason: 'SQLite' }
  try {
    const result = await query('SELECT 1 AS ok')
    return {
      ok: (result.rows?.length ?? 0) > 0,
      poolSize: (pool as unknown as { totalCount?: number })?.totalCount || 0,
      idleCount: (pool as unknown as { idleCount?: number })?.idleCount || 0,
    }
  } catch (err: unknown) {
    return { ok: false, reason: (err as Error).message }
  }
}

export { getPool, usingPostgres, query, endPool, healthCheck }
