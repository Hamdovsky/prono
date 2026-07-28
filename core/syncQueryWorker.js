const { parentPort, workerData } = require('worker_threads')
const { Pool } = require('pg')

// ── Persistent PG pool ──────────────────────────────────────────────
let pool
try {
  pool = new Pool({
    connectionString: workerData.databaseUrl,
    ssl:
      workerData.databaseUrl.includes('supabase.co') || workerData.databaseUrl.includes('neon.tech')
        ? { rejectUnauthorized: false }
        : undefined,
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  })
  pool.on('error', (err) => {
    parentPort.postMessage({ type: 'error', error: `Pool error: ${err.message}` })
  })
} catch (e) {
  parentPort.postMessage({ type: 'error', error: `Pool init failed: ${e.message}` })
  process.exit(1)
}

// ── Shared flag for main-thread sync ─────────────────────────────────
const flagBuffer = new Int32Array(workerData.sab)

parentPort.on('message', async (msg) => {
  const { type, text, params, queryId, originalSql } = msg

  if (type === 'query') {
    try {
      const result = await pool.query(text, params || [])
      parentPort.postMessage({
        type: 'result',
        queryId,
        rows: result.rows,
        rowCount: result.rowCount,
        fields: result.fields,
      })
    } catch (e) {
      parentPort.postMessage({
        type: 'result',
        queryId,
        error: e.message,
        stack: e.stack,
        code: e.code,
        sql: originalSql || text,
      })
    } finally {
      Atomics.store(flagBuffer, 0, 1)
      Atomics.notify(flagBuffer, 0)
    }
  } else if (type === 'end') {
    try {
      await pool.end()
    } catch (_) {}
    process.exit(0)
  }
})

parentPort.postMessage({ type: 'ready' })
