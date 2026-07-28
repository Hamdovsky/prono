/**
 * healthDashboard.js — Full system health check
 */
const { query } = require('../core/pg_connector')

async function getFullHealth() {
  const result = { status: 'ok', timestamp: new Date().toISOString(), services: {} }

  // 1. Neon PostgreSQL
  try {
    const tables = [
      'soccer_fixtures',
      'soccer_match_stats',
      'soccer_odds',
      'soccer_teams',
      'soccer_leagues',
      'archive_football_data',
      'league_model_parameters',
    ]
    const stats = {}
    for (const t of tables) {
      const r = await query(`SELECT COUNT(*) as cnt FROM ${t}`)
      stats[t] = r && r.rows ? parseInt(r.rows[0].cnt) : 0
    }
    result.services.neon = {
      status: 'connected',
      stats,
      totalRows: Object.values(stats).reduce((a, b) => a + b, 0),
    }
  } catch (e) {
    result.services.neon = { status: 'error', error: e.message }
  }

  // 2. Memory
  const mem = process.memoryUsage()
  result.services.memory = {
    rss: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
    heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`,
    heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
  }

  // 3. Uptime
  result.services.uptime = `${(process.uptime() / 60).toFixed(0)} min`

  // 4. Theta optimizer status
  try {
    const thetaOpt = require('./thetaOptimizer')
    const map = thetaOpt.getOptimizedMap()
    result.services.theta = { leagues: Object.keys(map).length, cached: map.size > 0 }
  } catch (e) {
    result.services.theta = { error: e.message }
  }

  return result
}

module.exports = { getFullHealth }
