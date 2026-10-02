/**
 * optaPredictions.js — persistance + orchestration des prédictions Opta 1X2
 * (source `theanalyst.com`, API publique performfeeds — voir theAnalystClient.js).
 *
 * Follows les conventions des extracteurs existants (oddsportalStatsExtractor) :
 *   - dry-run par défaut (write=false),
 *   - upsert idempotent (ON CONFLICT DO UPDATE),
 *   - gate cron THE_ANALYST_ENABLED (défaut OFF).
 *
 * Données stockées : probabilités Opta (pourcentages), PAS des cotes bookmaker :
 * aucun impact sur le pipeline odds (EV/ROI), conforme à ODDS_REJECT_SYNTHETIC.
 */
const logger = require('../core/logger')
const database = require('../core/database')
const { client, LEAGUES } = require('./theAnalystClient')

const DEFAULT_HORIZON_DAYS = Number(process.env.THE_ANALYST_HORIZON_DAYS || 4)

function getDb(db) {
  return db || database
}

// ─── helpers driver (SQLite better-sqlite3 vs PG) ───────────────────────────

function runUpsert(db, row) {
  const now = Date.now()
  const params = [
    row.matchId,
    row.kickoffMs,
    row.league,
    row.home,
    row.away,
    row.prob_home,
    row.prob_draw,
    row.prob_away,
    now,
  ]
  if (typeof db.prepare === 'function') {
    db.prepare(
      `INSERT INTO opta_predictions
        (match_id, kickoff, league, home_team, away_team, prob_home, prob_draw, prob_away, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_id) DO UPDATE SET
         kickoff = excluded.kickoff,
         league = excluded.league,
         home_team = excluded.home_team,
         away_team = excluded.away_team,
         prob_home = excluded.prob_home,
         prob_draw = excluded.prob_draw,
         prob_away = excluded.prob_away,
         updated_at = excluded.updated_at`
    ).run(...params)
    return { tick: true }
  }
  // PG
  return db.query
    ? db.execOrThrow(`INSERT INTO opta_predictions
        (match_id, kickoff, league, home_team, away_team, prob_home, prob_draw, prob_away, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(match_id) DO UPDATE SET kickoff=$2, league=$3, home_team=$4, away_team=$5,
        prob_home=$6, prob_draw=$7, prob_away=$8, updated_at=$9`, params)
    : null
}

function selectAll(db, sql, params = []) {
  if (typeof db.prepare === 'function') return db.prepare(sql).all(...params)
  return db.query ? db.query(sql, params).rows : []
}

// ─── API produit ─────────────────────────────────────────────────────────────

/**
 * Synchronise les prédictions Opta depuis l'API publique.
 * @returns stats {leagues, matchesSeen, withPredictions, written, errors, durationMs, league}
 */
async function sync(db, { write = false, horizonDays = DEFAULT_HORIZON_DAYS, maxLeagues = LEAGUES.length } = {}) {
  const dbx = getDb(db)
  const started = Date.now()
  const { results, breaker } = await client.fetchAll({ horizonDays, maxLeagues })
  if (breaker) return { breaker, written: 0, withPredictions: 0, errors: 0, results }

  let written = 0
  if (write) {
    for (const row of results) {
      try {
        runUpsert(dbx, row)
        written++
      } catch (e) {
        logger.error(`[THEANALYST] upsert failed ${row.matchId}: ${e.message}`)
      }
    }
  }

  const stats = client.getStatus()
  logger.info(
    `[THEANALYST] sync done: leagues=${stats.leaguesScanned} matchesSeen=${stats.matchesSeen} ` +
      `withPred=${stats.withPredictions} written=${written} err=${stats.errors} ` +
      `duration=${Date.now() - started}ms write=${write}`
  )
  return {
    results,
    written,
    withPredictions: stats.withPredictions,
    matchesSeen: stats.matchesSeen,
    errors: stats.errors,
    durationMs: Date.now() - started,
  }
}

/**
 * Prédictions Opta stockées. Paramètres : league (code ou label), limit, horizonMs.
 */
function listPredictions(db, { league, limit = 50, horizonMs = 7 * 86400000 } = {}) {
  const dbx = getDb(db)
  let sql = `SELECT match_id, kickoff, league, home_team, away_team, prob_home, prob_draw, prob_away, updated_at
             FROM opta_predictions`
  const clauses = []
  const params = []
  if (league) {
    clauses.push('(league = ? OR league = ?)')
    params.push(league, league)
  }
  clauses.push('kickoff >= ?')
  params.push(Date.now() - 86400000 - horizonMs)
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ')
  sql += ' ORDER BY kickoff LIMIT ' + Math.max(1, Math.min(500, Number(limit) || 50))
  return selectAll(dbx, sql, params)
}

/**
 * Statistiques de couverture pour /api/opta/status.
 */
function getStats(db) {
  const dbx = getDb(db)
  const rows = selectAll(dbx, `SELECT league, COUNT(*) n, MIN(updated_at) lastPing FROM opta_predictions GROUP BY league`)
  const total = selectAll(dbx, `SELECT COUNT(*) n FROM opta_predictions`)
  return {
    total: total[0] && total[0].n ? total[0].n : 0,
    byLeague: rows || [],
    client: client.getStatus(),
  }
}

// ─── Dashboard enrichment helper ─────────────────────────────────────────────

function _toMsStart(ts) {
  if (!ts || ts === 0) return 0
  if (typeof ts === 'string' && ts.includes('T')) return new Date(ts).getTime()
  const n = parseInt(ts)
  if (!Number.isFinite(n) || n === 0) return 0
  return n > 1e11 ? n : n * 1000
}

/**
 * Attache `.opta = { home, draw, away, updatedAt }` aux matchs d'une liste
 * d'upcoming en se basant sur une jointure heuristique (normTeam+date±1j).
 * Mutations idempotentes sur la liste passée (retourne la même référence).
 */
function enrichMatchesOpta(db, matches, { toleranceMs = 24 * 3600000 } = {}) {
  if (!Array.isArray(matches) || !matches.length) return matches
  try {
    const { normTeam } = require('../core/fdJoin')
    const rows = listPredictions(db, { limit: 500 })
    if (!rows.length) return matches
    const index = new Map()
    for (const r of rows) {
      const key = `${normTeam(r.home_team)}|${normTeam(r.away_team)}|${r.kickoff}`
      index.set(key, r)
    }
    for (const m of matches) {
      const ms = _toMsStart(m.startTimestamp)
      if (!ms) continue
      const k = `${normTeam(m.homeTeam)}|${normTeam(m.awayTeam)}|${ms}`
      const exact = index.get(k)
      if (exact) {
        m.opta = { home: exact.prob_home, draw: exact.prob_draw, away: exact.prob_away, updatedAt: exact.updated_at }
        continue
      }
      // fallback ±tolerance
      for (const [key, r] of index.entries()) {
        const [nh, na, ko] = key.split('|')
        if (nh !== normTeam(m.homeTeam) || na !== normTeam(m.awayTeam)) continue
        if (Math.abs(Number(ko) - ms) <= toleranceMs) {
          m.opta = { home: r.prob_home, draw: r.prob_draw, away: r.prob_away, updatedAt: r.updated_at }
          break
        }
      }
    }
  } catch (e) {
    logger.warn(`[THEANALYST] enrichMatchesOpta failed: ${e.message}`)
  }
  return matches
}

module.exports = { sync, listPredictions, getStats, runUpsert, LEAGUES, enrichMatchesOpta }
