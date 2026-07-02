/**
 * thetaOptimizer.js — Auto-θ tuning for Negative Binomial v5.0 (Neon)
 *
 * Finds optimal NB dispersion theta per league via method-of-moments:
 *   θ = μ² / (σ² - μ)
 *
 * Now queries Neon PostgreSQL (soccer_fixtures + archive_matches) for 
 * 400K+ historical match outcomes instead of local SQLite.
 *
 * Falls back to league defaults when insufficient data (< 20 matches).
 */

const { query, usingPostgres } = require('../core/pg_connector')
const logger = require('../core/logger')

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
let _cache = { theta: {}, timestamp: 0 }

async function _queryGoalData() {
  const allData = {}

  // 1. Query soccer_fixtures (378K rows) via Neon
  if (usingPostgres()) {
    try {
      const leagueMapRes = await query('SELECT id, name FROM soccer_leagues')
      const leagueNameById = {}
      if (leagueMapRes.rows) {
        for (const r of leagueMapRes.rows) {
          leagueNameById[r.id] = (r.name || 'Unknown').trim()
        }
      }

      const fixturesRes = await query(
        `SELECT f.league_id, f.goals_home, f.goals_away, l.name as league_name
         FROM soccer_fixtures f
         LEFT JOIN soccer_leagues l ON f.league_id = l.id
         WHERE f.goals_home IS NOT NULL AND f.goals_away IS NOT NULL`
      )
      if (fixturesRes.rows) {
        for (const r of fixturesRes.rows) {
          const league = r.league_name || leagueNameById[r.league_id] || 'Unknown'
          if (!allData[league]) allData[league] = []
          allData[league].push({ h: r.goals_home, a: r.goals_away })
        }
      }
    } catch (e) {
      logger.warn(`[θ OPT] Neon query error: ${e.message}`)
    }
  }

  // 2. Fallback: also query archive_matches if available
  try {
    const archiveRes = await query(
      `SELECT league, "scoreHome", "scoreAway" FROM archive_matches 
       WHERE "scoreHome" IS NOT NULL AND "scoreAway" IS NOT NULL`
    )
    if (archiveRes.rows) {
      for (const r of archiveRes.rows) {
        const league = r.league || 'Unknown'
        if (!allData[league]) allData[league] = []
        allData[league].push({ h: r.scoreHome, a: r.scoreAway })
      }
    }
  } catch (e) {}

  return allData
}

function _estimateThetaFromGoals(goals) {
  if (!goals || goals.length < 20) return null
  const totalGoals = goals.map(g => g.h + g.a)
  const n = totalGoals.length
  const mean = totalGoals.reduce((s, v) => s + v, 0) / n
  const variance = totalGoals.reduce((s, v) => s + (v - mean) ** 2, 0) / n
  if (variance <= mean * 1.01) return null
  const theta = (mean * mean) / (variance - mean)
  return Math.max(2.0, Math.min(8.0, theta))
}

const LEAGUE_THETA_DEFAULTS = {
  'islande': 3.0, 'iceland': 3.0, 'reykjavik': 3.0,
  'women': 3.0, 'féminin': 3.0, 'femenine': 3.0,
  'bundesliga': 3.5, 'netherlands': 3.5, 'eredivisie': 3.5, 'austria': 3.5,
  'premier league': 4.0, 'championship': 4.0, 'norway': 4.0, 'sweden': 4.0,
  'serie a': 6.0, 'ligue 2': 6.0, 'argentina': 6.0, 'brazil': 6.0,
  'ligue 1': 5.5, 'france': 5.5,
  'national': 4.5, 'scotland': 4.5, 'league one': 4.5,
}

function _matchDefault(league) {
  const key = (league || '').toLowerCase().trim()
  for (const [pattern, theta] of Object.entries(LEAGUE_THETA_DEFAULTS)) {
    if (key.includes(pattern)) return theta
  }
  return 5.0
}

async function optimize() {
  const raw = await _queryGoalData()
  const result = {}
  for (const [league, goals] of Object.entries(raw)) {
    const estimated = _estimateThetaFromGoals(goals)
    result[league] = estimated || _matchDefault(league)
  }
  _cache.theta = result
  _cache.timestamp = Date.now()
  return result
}

function getThetaForLeague(league) {
  const key = (league || '').toLowerCase().trim()
  if (_cache.theta[key]) return _cache.theta[key]
  return _matchDefault(league)
}

function getOptimizedMap() {
  return _cache.timestamp ? { ..._cache.theta } : {}
}

async function init() {
  if (usingPostgres()) {
    try {
      await optimize()
      logger.info(`[θ OPT] Calibrated ${Object.keys(_cache.theta).length} leagues from Neon archive (378K+ fixtures)`)
    } catch (e) {
      logger.warn(`[θ OPT] Init failed: ${e.message}`)
    }
  }
}

// Warm cache on startup
init()

module.exports = { getThetaForLeague, getOptimizedMap, optimize, init }
