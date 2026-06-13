/**
 * thetaOptimizer.js — Auto-θ tuning for Negative Binomial
 *
 * Finds optimal NB dispersion theta per league via method-of-moments:
 *   θ = μ² / (σ² - μ)
 *
 * Falls back to league defaults when insufficient data (< 20 matches).
 */

const path = require('path')
const fs = require('fs')

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
let _cache = { theta: {}, timestamp: 0 }

function _getDB() {
  const Database = require('better-sqlite3')
  const files = [
    path.join(__dirname, '..', 'data', 'historical_archive.sqlite'),
    path.join(__dirname, '..', 'data', 'tactical.db')
  ]
  for (const f of files) {
    if (fs.existsSync(f)) {
      try { return new Database(f, { readonly: true }) } catch (e) {}
    }
  }
  return null
}

function _queryGoalData(db) {
  const tables = ['archive_matches', 'historical_matches', 'matches', 'historical_batch']
  const allData = {}
  for (const tbl of tables) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name)
      if (!cols.includes('scoreHome') || !cols.includes('scoreAway') || !cols.includes('homeTeam')) continue
      const leagueCol = cols.includes('tournament_name') ? 'tournament_name' : (cols.includes('league') ? 'league' : null)
      if (!leagueCol) continue
      const rows = db.prepare(
        `SELECT "${leagueCol}" AS league, scoreHome, scoreAway FROM ${tbl} WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL`
      ).all()
      for (const r of rows) {
        const league = r.league || 'unknown'
        if (!allData[league]) allData[league] = []
        allData[league].push({ h: r.scoreHome, a: r.scoreAway })
      }
    } catch (e) {}
  }
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

function optimize() {
  const db = _getDB()
  if (!db) return {}
  const raw = _queryGoalData(db)
  try { db.close() } catch (e) {}
  const result = {}
  for (const [league, goals] of Object.entries(raw)) {
    const estimated = _estimateThetaFromGoals(goals)
    result[league] = estimated || _matchDefault(league)
  }
  return result
}

function getThetaForLeague(league) {
  if (Date.now() - _cache.timestamp > CACHE_TTL_MS || !_cache.timestamp) {
    try {
      _cache.theta = optimize()
      _cache.timestamp = Date.now()
    } catch (e) {
      if (!_cache.timestamp) _cache.theta = {}
      _cache.timestamp = Date.now()
    }
  }
  return _cache.theta[league] || _matchDefault(league)
}

function getOptimizedMap() {
  if (Date.now() - _cache.timestamp > CACHE_TTL_MS || !_cache.timestamp) {
    try {
      _cache.theta = optimize()
      _cache.timestamp = Date.now()
    } catch (e) {
      if (!_cache.timestamp) _cache.theta = {}
      _cache.timestamp = Date.now()
    }
  }
  return { ..._cache.theta }
}

module.exports = { getThetaForLeague, getOptimizedMap, optimize }
