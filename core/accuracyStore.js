/**
 * accuracyStore.js — Unified accuracy persistence layer
 * ─────────────────────────────────────────────────────────
 * Single source of truth for prediction accuracy:
 *   - Fichier local (data/accuracy_log.json) — fallback / SQLite
 *   - Postgres (table prediction_accuracy) — durable across Render redeploys
 *
 * Schéma UNIFIÉ unique (fini l'écrasement entre settlement & today_analysis) :
 * {
 *   entries:    [ { date, accuracy, hits, total, roi, ... } ]   // daily aggregates
 *   byLeague:   { "Ligue": [ { match, predicted, actual, is_correct, ... } ] }
 *   _global:    { accuracy, total, won, updated }
 * }
 */

const fs = require('fs')
const path = require('path')
const logger = require('./logger')
const pg = require('./pg_connector')

const LOG_PATH = path.join(__dirname, '..', 'data', 'accuracy_log.json')

const EMPTY = { entries: [], lastUpdated: null, recordStreak: 0, byLeague: {}, _global: null }

function loadFile() {
  try {
    if (fs.existsSync(LOG_PATH)) {
      const data = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'))
      return { ...EMPTY, ...data }
    }
  } catch (_) {}
  return { ...EMPTY, entries: [], byLeague: {} }
}

function saveFile(log) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2))
  } catch (e) {
    logger.error(`[ACCURACY-STORE] File save error: ${e.message}`)
  }
}

// ── Postgres helpers ────────────────────────────────────────────────────

function pgEnabled() {
  return pg && pg.usingPostgres ? pg.usingPostgres() : false
}

async function ensureTable() {
  if (!pgEnabled()) return
  try {
    await pg.query(
      `CREATE TABLE IF NOT EXISTS prediction_accuracy (
        id TEXT PRIMARY KEY,
        league TEXT,
        match_id TEXT,
        predicted TEXT,
        actual TEXT,
        is_correct BOOLEAN,
        score TEXT,
        confidence REAL,
        market TEXT,
        timestamp BIGINT
      )`
    )
    await pg.query(
      `CREATE INDEX IF NOT EXISTS idx_accuracy_timestamp ON prediction_accuracy(timestamp)`
    )
  } catch (e) {
    logger.warn(`[ACC-STORE] Ensure table error: ${e.message}`)
  }
}

async function pgAppend(entry) {
  if (!pgEnabled()) return
  try {
    await pg.query(
      `INSERT INTO prediction_accuracy
        (match_id, league, predicted, actual, is_correct, score, confidence, market, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING`,
      [
        entry.match_id ?? null,
        entry.league ?? null,
        entry.predicted ?? null,
        entry.actual ?? null,
        entry.is_correct ?? null,
        entry.score ?? null,
        entry.confidence ?? null,
        entry.market ?? null,
        entry.timestamp ?? String(Date.now()),
      ]
    )
  } catch (e) {
    // don't spam logs on non-blocking write
    logger.debug(`[ACC-STORE] PG append error: ${e.message}`)
  }
}

async function pgLoadRecent(limit = 2000) {
  if (!pgEnabled()) return null
  try {
    const res = await pg.query(
      `SELECT league, predicted, actual, is_correct, score, confidence, timestamp
       FROM prediction_accuracy
       ORDER BY timestamp DESC
       LIMIT $1`,
      [limit]
    )
    return res.rows || []
  } catch (e) {
    logger.warn(`[ACC-STORE] PG load error: ${e.message}`)
    return null
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Load accuracy log (unified schema). Falls back to file, then Postgres.
 */
async function loadAccuracyLog() {
  const local = loadFile()
  if (!pgEnabled()) return local

  const pgRows = await pgLoadRecent(200)
  if (!pgRows || pgRows.length === 0) return local

  // Supplement entries with PG when file has none
  if (local.entries.length === 0 && Array.isArray(pgRows)) {
    const byLeague = {}
    for (const r of pgRows) {
      const league = r.league || 'Unknown'
      if (!byLeague[league]) byLeague[league] = []
      byLeague[league].push({
        match_id: r.match_id,
        match: r.match_id,
        predicted: r.predicted,
        actual: r.actual,
        is_correct: r.is_correct,
        score: r.score,
        confidence: r.confidence,
        market: r.market,
        timestamp: r.timestamp,
      })
    }
    return { ...EMPTY, byLeague: Object.keys(byLeague).length ? byLeague : local.byLeague }
  }

  return local
}

function loadAccuracyLogSyncOnly() {
  return loadFile()
}

function saveAccuracyLog(log) {
  saveFile(log)
}

/**
 * Record one settled match result. Writes to file AND Postgres.
 */
function appendResult(entry) {
  const log = loadFile()
  const league = entry.league || 'Unknown'
  if (!log.byLeague) log.byLeague = {}
  if (!log.byLeague[league]) log.byLeague[league] = []

  const newEntry = {
    match_id: entry.match_id,
    match: entry.match,
    score: entry.score,
    predicted: entry.predicted,
    actual: entry.actual,
    is_correct: entry.is_correct,
    confidence: entry.confidence,
    market: entry.market,
    timestamp: entry.timestamp ?? String(Date.now()),
  }

  // Idempotent: replace any existing entry for the same match (re-settle safe)
  const list = log.byLeague[league]
  const existingIdx = list.findIndex((e) => String(e.match_id) === String(newEntry.match_id))
  if (existingIdx >= 0) list[existingIdx] = newEntry
  else list.push(newEntry)

  // Keep last 50 per league
  if (log.byLeague[league].length > 50) {
    log.byLeague[league] = log.byLeague[league].slice(-50)
  }

  // Global accuracy
  let totalW = 0
  let totalN = 0
  for (const entries of Object.values(log.byLeague)) {
    for (const e of entries) {
      totalN++
      if (e.is_correct) totalW++
    }
  }
  log._global = {
    accuracy: totalN > 0 ? Math.round((totalW / totalN) * 1000) / 10 : 0,
    total: totalN,
    won: totalW,
    updated: new Date().toISOString(),
  }

  saveFile(log)
  // Durable copy (async, non-blocking)
  pgAppend(entry)
  return log._global
}

/**
 * Persist a daily snapshot (from accuracy_snapshot.js) to Postgres.
 */
async function persistSnapshot(snapshot) {
  if (!pgEnabled()) return
  try {
    await ensureTable()
    await pg.query(
      `CREATE TABLE IF NOT EXISTS accuracy_snapshot (
        date TEXT PRIMARY KEY,
        accuracy REAL,
        correct INTEGER,
        total INTEGER,
        concours_count INTEGER,
        log_loss REAL,
        crowd_accuracy REAL,
        created_at TEXT
      )`
    )
    await pg.query(
      `INSERT INTO accuracy_snapshot
        (date, accuracy, correct, total, concours_count, log_loss, crowd_accuracy, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (date) DO UPDATE SET
        accuracy = EXCLUDED.accuracy,
        correct = EXCLUDED.correct,
        total = EXCLUDED.total,
        concours_count = EXCLUDED.concours_count,
        log_loss = EXCLUDED.log_loss,
        crowd_accuracy = EXCLUDED.crowd_accuracy,
        created_at = EXCLUDED.created_at`,
      [
        snapshot.date,
        snapshot.accuracy,
        snapshot.correct ?? 0,
        snapshot.total ?? 0,
        snapshot.concoursCount ?? 0,
        snapshot.logLoss ?? null,
        snapshot.crowdAccuracy ?? null,
        new Date().toISOString(),
      ]
    )
  } catch (e) {
    logger.warn(`[ACC-STORE] Snapshot persist error: ${e.message}`)
  }
}

/**
 * Remove a settled match entry (by match_id) from every league — used to
 * purge accuracy entries that have no real prediction (re-settle safe).
 */
function removeResult(matchId) {
  const log = loadFile()
  if (!log.byLeague) {
    saveFile(log)
    return null
  }
  let removed = false
  for (const league of Object.keys(log.byLeague)) {
    const before = log.byLeague[league].length
    log.byLeague[league] = log.byLeague[league].filter(
      (e) => String(e.match_id) !== String(matchId)
    )
    if (log.byLeague[league].length !== before) removed = true
    if (log.byLeague[league].length === 0) delete log.byLeague[league]
  }
  if (removed) {
    let totalW = 0
    let totalN = 0
    for (const entries of Object.values(log.byLeague)) {
      for (const e of entries) {
        totalN++
        if (e.is_correct) totalW++
      }
    }
    log._global = {
      accuracy: totalN > 0 ? Math.round((totalW / totalN) * 1000) / 10 : 0,
      total: totalN,
      won: totalW,
      updated: new Date().toISOString(),
    }
    saveFile(log)
  }
  return removed
}

module.exports = {
  loadAccuracyLog,
  loadAccuracyLogSyncOnly,
  saveAccuracyLog,
  appendResult,
  removeResult,
  persistSnapshot,
}