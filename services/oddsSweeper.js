/**
 * oddsSweeper.js — Récupération en masse des COTES RÉELLES pour les matchs
 * programmés (source gratuite BetExplorer via la chaîne services/scrapers).
 *
 * Problème mesuré : seuls ~4 % des matchs programmés portent des cotes 1X2
 * réelles (le scraper SofaScore ne fournit des odds « featured » que sur les
 * gros matchs). Sans cotes réelles, edge / EV / Kelly / CLV sont de la fiction.
 *
 * Ce module comble le trou :
 *   1. Sélectionne les matchs programmés (horizon ODDS_SWEEP_HORIZON_DAYS)
 *      qui n'ont pas encore 1X2 complet (ou O2.5/BTTS manquants), triés par
 *      proximité du coup d'envoi, les matchs sans 1X2 en priorité.
 *   2. Pour chacun : dataFusionService.fetchOdds(match) → persiste via
 *      database.persistOdds (1X2 + O2.5 + BTTS + odds_source).
 *   3. Budget par passe (ODDS_SWEEP_BUDGET_MS) → reprise au cycle suivant
 *      (modèle oddsBackfill.js). Mémo de dernière tentative par match
 *      (ODDS_SWEEP_RETRY_MS) pour ne pas marteler un match en échec.
 *   4. Écrit aussi odds_history (type LIVE) + odds_home_open (première cote)
 *      → alimente le CLV (quant_performance) déjà en place.
 *
 * Lock Redis (odds:sweep:lock) pour éviter les doubles runs.
 */

const logger = require('../core/logger')
const database = require('../core/database')
const redisCache = require('./redisCache')

const HORIZON_DAYS = parseInt(process.env.ODDS_SWEEP_HORIZON_DAYS || '3', 10)
const BUDGET_MS = parseInt(process.env.ODDS_SWEEP_BUDGET_MS || String(30 * 60 * 1000), 10)
const RETRY_MS = parseInt(process.env.ODDS_SWEEP_RETRY_MS || String(10 * 60 * 1000), 10)
// Temps max par match : évite qu'un scraper lent (ex. bypass curl_cffi sans
// timeout interne) bloque la passe et la file du cron.
const FETCH_TIMEOUT_MS = parseInt(process.env.ODDS_SWEEP_FETCH_TIMEOUT_MS || '30000', 10)
const LOCK_TTL = 3600
const LOCK_KEY = 'odds:sweep:lock'
const STATUSES = ['scheduled', 'upcoming', 'NOT_STARTED', 'NS']
const LOOKBACK_MS = 2 * 3600 * 1000 // matchs commencés depuis peu encore inclus

let _attemptedAt = new Map()
let _running = false
let _lastSweep = null
let _startedAt = 0
// ── Safety: si un sweep reste bloqué plus de 10 min, on force le reset.
// Évite qu'un crash silencieux (process Node orphelin, fetchOdds hang) bloque
// tous les sweeps suivants pendant des heures (audit P0-2026-08-29).
const MAX_SWEEP_MS = parseInt(process.env.ODDS_SWEEP_MAX_MS || String(10 * 60 * 1000), 10)

// ── Petits utilitaires ───────────────────────────────────────────
function getDb(db) {
  return db || database.db
}

function toTsMs(m) {
  const raw = m.startTimestamp
  if (raw == null || raw === 0) return 0
  if (typeof raw === 'string' && raw.includes('T')) return new Date(raw).getTime()
  const n = parseInt(raw)
  if (isNaN(n) || n === 0) return 0
  return n > 1e11 ? n : n * 1000
}

function num(v) {
  const f = parseFloat(v)
  return !isNaN(f) && f > 1 ? f : null
}

function hasFull1x2(m) {
  return !!(num(m.odds_home) && num(m.odds_draw) && num(m.odds_away))
}

function hasFullOu(m) {
  return !!(num(m.odds_over25) && num(m.odds_under25))
}

function hasFullBtts(m) {
  return !!(num(m.odds_btts_yes) && num(m.odds_btts_no))
}

function needsWork(m) {
  return !hasFull1x2(m) || !hasFullOu(m) || !hasFullBtts(m)
}

// ── Sélection de la file de matchs ───────────────────────────────
function selectQueue({ db, horizonDays = HORIZON_DAYS } = {}) {
  const d = getDb(db)
  const out = { queue: [], scanned: 0, with1x2: 0, withOu: 0, withBtts: 0 }
  if (!d) return out
  let matches = []
  try {
    matches = d
      .prepare(`SELECT id, "homeTeam", "awayTeam", league, status, "startTimestamp", category_name, odds_home, odds_draw, odds_away, odds_over25, odds_under25, odds_btts_yes, odds_btts_no, odds_home_open FROM matches WHERE status IN (${STATUSES.map(() => '?').join(',')})`)
      .all(...STATUSES)
  } catch (e) {
    logger.warn(`[ODDS-SWEEP] selectQueue failed: ${e.message}`)
    return out
  }

  const now = Date.now()
  const horizonEnd = now + horizonDays * 24 * 3600 * 1000
  const windowStart = now - LOOKBACK_MS

  const queue = []
  for (const m of matches) {
    out.scanned++
    if (hasFull1x2(m)) out.with1x2++
    if (hasFullOu(m)) out.withOu++
    if (hasFullBtts(m)) out.withBtts++
    const ts = toTsMs(m)
    if (!ts || ts < windowStart || ts > horizonEnd) continue
    if (!needsWork(m)) continue
    queue.push({
      ...m,
      _ts: ts,
      _primary: !hasFull1x2(m),
      _needsOu: !hasFullOu(m),
      _needsBtts: !hasFullBtts(m),
    })
  }

  // 1X2 manquant en priorité, puis par proximité du coup d'envoi.
  queue.sort((a, b) => (b._primary ? 1 : 0) - (a._primary ? 1 : 0) || a._ts - b._ts)
  out.queue = queue
  return out
}

// ── Persistance de la cote dans matches (idempotent) ─────────────
// dataFusionService.fetchOdds persiste déjà via database.persistOdds ; cette
// étape garantit le contrat du sweeper même si le fetch est mocké/partiel.
// COALESCE → la première cote réelle est conservée.
function recordPersistedOdds(matchId, odds, { db } = {}) {
  const d = getDb(db)
  if (!d) return
  try {
    d.prepare(
      `UPDATE matches SET
         odds_home = COALESCE(?, odds_home),
         odds_draw = COALESCE(?, odds_draw),
         odds_away = COALESCE(?, odds_away),
         odds_over25 = COALESCE(?, odds_over25),
         odds_under25 = COALESCE(?, odds_under25),
         odds_btts_yes = COALESCE(?, odds_btts_yes),
         odds_btts_no = COALESCE(?, odds_btts_no),
         odds_source = ?,
         last_updated = ?
       WHERE id = ?`
    ).run(
      num(odds.home),
      num(odds.draw),
      num(odds.away),
      num(odds.over25),
      num(odds.under25),
      num(odds.btts_yes),
      num(odds.btts_no),
      odds.source || 'betexplorer',
      Date.now(),
      String(matchId)
    )
  } catch (e) {
    logger.debug(`[ODDS-SWEEP] persist skipped for ${matchId}: ${e.message}`)
  }
}

// ── Persistance de la cote dans odds_history (CLV) ───────────────
function recordOddsHistory(matchId, odds, { db } = {}) {
  const d = getDb(db)
  if (!d) return
  try {
    const h = num(odds.home)
    const dr = num(odds.draw)
    const a = num(odds.away)
    if (h && dr && a) {
      d.prepare(
        `INSERT INTO odds_history (match_id, odds_home, odds_draw, odds_away, type, timestamp)
         VALUES (?, ?, ?, ?, 'LIVE', ?)`
      ).run(String(matchId), h, dr, a, Date.now())
    }
  } catch (e) {
    logger.debug(`[ODDS-SWEEP] odds_history skipped for ${matchId}: ${e.message}`)
  }
}

function recordOpeningOdds(matchId, odds, { db } = {}) {
  const d = getDb(db)
  if (!d) return
  try {
    const h = num(odds.home)
    const dr = num(odds.draw)
    const a = num(odds.away)
    if (h && dr && a) {
      d.prepare(
        `UPDATE matches SET
           odds_home_open = COALESCE(odds_home_open, ?),
           odds_draw_open = COALESCE(odds_draw_open, ?),
           odds_away_open = COALESCE(odds_away_open, ?)
         WHERE id = ? AND odds_home_open IS NULL`
      ).run(h, dr, a, String(matchId))
    }
  } catch (e) {
    logger.debug(`[ODDS-SWEEP] opening odds skipped for ${matchId}: ${e.message}`)
  }
}

// ── Passe unique (testable) ──────────────────────────────────────
async function runSweep({ queue, fetchOdds, db, budgetMs = BUDGET_MS, retryMs = RETRY_MS, limit = 0 } = {}) {
  const now = Date.now()
  const startedAt = now
  const stats = {
    scanned: 0,
    targeted: queue.length,
    primary: queue.filter((m) => m._primary).length,
    fetched: 0,
    failed: 0,
    skipped: 0,
    budget: false,
    budgetUsedMs: 0,
  }

  for (const m of queue) {
    if (Date.now() - startedAt > budgetMs) {
      stats.budget = true
      break
    }
    if (limit > 0 && stats.fetched + stats.failed + stats.skipped >= limit) break

    const last = _attemptedAt.get(String(m.id))
    if (last && Date.now() - last < retryMs) {
      stats.skipped++
      continue
    }
    _attemptedAt.set(String(m.id), Date.now())
    stats.scanned++

let result = null
    try {
      const p = fetchOdds(m)
      result = await Promise.race([
        p,
        new Promise((resolve) => setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
      ])
      if (result === null) {
        logger.debug(`[ODDS-SWEEP] timeout (>${FETCH_TIMEOUT_MS}ms) ${m.homeTeam} vs ${m.awayTeam}`)
      }
    } catch (e) {
      result = null
      logger.debug(`[ODDS-SWEEP] fetch error ${m.homeTeam} vs ${m.awayTeam}: ${e.message}`)
    }

    const gotSomething =
      result && (num(result.home) || num(result.over25) || num(result.btts_yes))
    if (gotSomething) {
      stats.fetched++
      recordPersistedOdds(m.id, result, { db })
      recordOddsHistory(m.id, result, { db })
      recordOpeningOdds(m.id, result, { db })
    } else {
      stats.failed++
    }
  }

  stats.budgetUsedMs = Date.now() - startedAt
  return stats
}

// ── Orchestration ────────────────────────────────────────────────
async function sweep(opts = {}) {
  // 🛡️ P0-2026-08-29: auto-reset si un sweep précédent est bloqué trop longtemps.
  if (_running && _startedAt > 0 && Date.now() - _startedAt > MAX_SWEEP_MS) {
    logger.warn(
      `[ODDS-SWEEP] Auto-reset stale _running flag (sweep > ${MAX_SWEEP_MS}ms, probable crash/hang)`
    )
    _running = false
    _startedAt = 0
    try {
      await redisCache.redis?.del(LOCK_KEY).catch(() => {})
    } catch (_) {}
  }
  if (_running && !opts.force) return { success: false, locked: true, running: true }

  // 🛡️ P0-2026-08-29: si le lock Redis est stale (>25min), on le libère pour
  // permettre aux sweeps suivants de tourner.
  if (!opts.skipLock) {
    try {
      const held = await redisCache.get(LOCK_KEY)
      if (held) {
        const heldTs = parseInt(String(held), 10)
        if (Number.isFinite(heldTs) && Date.now() - heldTs > 25 * 60 * 1000) {
          logger.warn(`[ODDS-SWEEP] Stale Redis lock detected (${held}), forcing release`)
          await redisCache.redis?.del(LOCK_KEY).catch(() => {})
        }
      }
    } catch (_) {}
  }

  const { db, horizonDays, budgetMs, limit, retryMs } = opts
  let locked = false
  if (!opts.skipLock) {
    try {
      const held = await redisCache.get(LOCK_KEY)
      if (held) return { success: false, locked: true, message: 'autre passe en cours' }
      await redisCache.set(LOCK_KEY, String(Date.now()), LOCK_TTL)
      locked = true
    } catch (e) {
      logger.debug(`[ODDS-SWEEP] Redis lock unavailable: ${e.message}`)
    }
  }

  _running = true
  _startedAt = Date.now()
  try {
    const selected = selectQueue({ db, horizonDays })
    const fetchOdds = opts.fetchOdds || (async (m) => {
      const dataFusionService = require('./dataFusionService')
      return dataFusionService.fetchOdds(m)
    })
    const stats = await runSweep({ queue: selected.queue, fetchOdds, db, budgetMs, limit, retryMs })
    _lastSweep = {
      at: new Date().toISOString(),
      scanned: stats.scanned,
      targeted: stats.targeted,
      fetched: stats.fetched,
      failed: stats.failed,
      skipped: stats.skipped,
      budget: stats.budget,
      coverage: coverage({ db, horizonDays }),
    }
    logger.info(
      `[ODDS-SWEEP] ${stats.fetched}/${stats.targeted} cotes récupérées (${stats.failed} échecs, ${stats.skipped} retry, budget=${stats.budget})`
    )
    return { success: true, stats: _lastSweep }
  } catch (e) {
    logger.error(`[ODDS-SWEEP] sweep failed: ${e.message}`)
    return { success: false, error: e.message }
  } finally {
    _running = false
    _startedAt = 0
    if (locked) {
      try {
        await redisCache.redis?.del(LOCK_KEY).catch(() => {})
      } catch (_) {}
    }
  }
}

// ── Observabilité ────────────────────────────────────────────────
function coverage({ db, horizonDays = HORIZON_DAYS } = {}) {
  const d = getDb(db)
  const out = { total: 0, with1x2: 0, withOu: 0, withBtts: 0, queue: 0 }
  if (!d) return out
  try {
    const rows = d
      .prepare(`SELECT id, "startTimestamp", odds_home, odds_draw, odds_away, odds_over25, odds_under25, odds_btts_yes, odds_btts_no FROM matches WHERE status IN (${STATUSES.map(() => '?').join(',')})`)
      .all(...STATUSES)
    const now = Date.now()
    const windowStart = now - LOOKBACK_MS
    const horizonEnd = now + horizonDays * 24 * 3600 * 1000
    out.total = rows.length
    for (const m of rows) {
      if (hasFull1x2(m)) out.with1x2++
      if (hasFullOu(m)) out.withOu++
      if (hasFullBtts(m)) out.withBtts++
      const ts = toTsMs(m)
      if (ts && ts >= windowStart && ts <= horizonEnd && needsWork(m)) out.queue++
    }
  } catch (e) {
    logger.warn(`[ODDS-SWEEP] coverage failed: ${e.message}`)
  }
  return out
}

async function getStatus() {
  const cov = coverage()
  let sources = []
  try {
    const dataFusionService = require('./dataFusionService')
    sources = dataFusionService.getStats()
  } catch (_) {}
  return {
    running: _running,
    lastSweep: _lastSweep,
    coverage: cov,
    coveragePct1x2: cov.total > 0 ? Math.round((cov.with1x2 / cov.total) * 1000) / 10 : 0,
    coveragePctOu: cov.total > 0 ? Math.round((cov.withOu / cov.total) * 1000) / 10 : 0,
    coveragePctBtts: cov.total > 0 ? Math.round((cov.withBtts / cov.total) * 1000) / 10 : 0,
    config: {
      horizonDays: HORIZON_DAYS,
      budgetMs: BUDGET_MS,
      retryMs: RETRY_MS,
      statuses: STATUSES,
    },
    sources,
  }
}

// 🛡️ P0-2026-08-29: force-release the in-memory _running flag + Redis lock.
// Use when sweep() is stuck (e.g. crash in fetchOdds that never released the lock).
async function forceReset() {
  const wasRunning = _running
  const heldFor = _startedAt > 0 ? Date.now() - _startedAt : 0
  _running = false
  _startedAt = 0
  try {
    await redisCache.redis?.del(LOCK_KEY).catch(() => {})
  } catch (_) {}
  logger.warn(
    `[ODDS-SWEEP] forceReset: wasRunning=${wasRunning} heldFor=${heldFor}ms, lock cleared`
  )
  return { wasRunning, heldForMs: heldFor, lockCleared: true }
}

module.exports = {
  sweep,
  getStatus,
  coverage,
  selectQueue,
  recordPersistedOdds,
  recordOddsHistory,
  forceReset,
  _internal: {
    hasFull1x2,
    hasFullOu,
    hasFullBtts,
    needsWork,
    toTsMs,
    __resetAttempts: () => {
      _attemptedAt = new Map()
      _lastSweep = null
    },
    __setRunning: (v) => {
      _running = v
    },
  },
}
