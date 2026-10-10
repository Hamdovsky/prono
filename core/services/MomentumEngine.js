const database = require('../database')
const logger = require('../logger')

// Audit 2026-10-10 : getTrend est appelé 2x par match (~450) dans getMatchXG.
// Cache par équipe pour éviter la requête learning_memory à chaque appel.
const _trendCache = new Map()
const TREND_TTL_MS = parseInt(process.env.TEAM_STATS_CACHE_MS || '600000', 10)

class MomentumEngine {
  /**
   * Calculates the "Trend Factor" for a team based on their last 3 matches in the learning memory.
   * @param {string} teamName
   * @returns {number} 1.0 (Neutral), > 1.0 (Hot), < 1.0 (Cold)
   */
  getTrend(teamName) {
    if (!teamName) return 1.0
    const cached = _trendCache.get(teamName)
    if (cached && Date.now() - cached.ts < TREND_TTL_MS) return cached.value
    let value = 1.0
    try {
      const db = database.db
      const matches = db
        .prepare(
          `
                SELECT actual, score, error_type 
                FROM learning_memory 
                WHERE (home_team = ? OR away_team = ?) 
                ORDER BY match_date DESC LIMIT 3
            `
        )
        .all(teamName, teamName)

      if (matches.length < 2) value = 1.0 // Not enough data for a trend
      else {
        let points = 0
        matches.forEach((m) => {
          const isHome = m.home_team === teamName
          if (m.actual === 'D') points += 1
          else if ((isHome && m.actual === 'H') || (!isHome && m.actual === 'A')) points += 3
        })

        // Scoring Logic:
        // 9 pts (3 wins) -> 1.15 boost
        // 7 pts -> 1.10
        // 0-1 pts -> 0.85 penalty
        if (points >= 9) value = 1.15
        else if (points >= 7) value = 1.1
        else if (points <= 1) value = 0.85
        else if (points <= 2) value = 0.92
        else value = 1.0
      }
    } catch (e) {
      value = 1.0
    }
    _trendCache.set(teamName, { ts: Date.now(), value })
    return value
  }

  /**
   * Specialized HT Momentum
   */
  getHTMomentum(teamName) {
    // Boost HT if the team often scores in the first half (simulated via trend for now)
    const trend = this.getTrend(teamName)
    return trend > 1 ? 1 + (trend - 1) * 1.5 : trend
  }
}

module.exports = new MomentumEngine()
