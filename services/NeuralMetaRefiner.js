/**
 * TITANIUM AI - NEURAL META-REFINER V3 (Node.js)
 * -----------------------------------------------
 * Corrects model bias in real-time using Bayesian Smoothing.
 * Learns from 'prediction_history' to adjust future probabilities.
 * V3: Adds temporal decay, draw correction, and persistence cache.
 */

const db = require('../core/database')
const logger = require('../core/logger')

class NeuralMetaRefiner {
  constructor() {
    this.biasCache = new Map()
    this.lastUpdate = 0
    this.CACHE_TTL = 300000 // 5 minutes
    this.MAX_HISTORY_DAYS = 180 // Only use last 6 months of data
    this.MIN_SAMPLES = 5 // Minimum samples for a bias key to be valid
    this.K_SHRINKAGE = 20 // Bayesian shrinkage parameter
  }

  async refreshBiasMatrix() {
    if (Date.now() - this.lastUpdate < this.CACHE_TTL) return

    try {
      const cutoffDate = new Date(Date.now() - this.MAX_HISTORY_DAYS * 86400000).toISOString()

      const rows = db.db
        .prepare(
          `
                SELECT league, prediction_type, probability, result, timestamp
                FROM prediction_history
                WHERE result IS NOT NULL
                  AND timestamp >= ?
                ORDER BY timestamp DESC
            `
        )
        .all(cutoffDate)

      const stats = {}
      for (const r of rows) {
        const key = `${r.league}|${r.prediction_type}`
        if (!stats[key]) stats[key] = { sumProb: 0, sumActual: 0, count: 0, recentCount: 0 }

        const prob = parseFloat(r.probability) || 0
        const won = r.result === 'won' || r.result === 'WON' ? 1 : 0

        stats[key].sumProb += prob
        stats[key].sumActual += won
        stats[key].count++

        // Count recent entries (last 30 days) for confidence weighting
        const createdTs = new Date(r.timestamp).getTime()
        if (Date.now() - createdTs < 30 * 86400000) {
          stats[key].recentCount++
        }
      }

      this.biasCache.clear()
      for (const [key, data] of Object.entries(stats)) {
        if (data.count < this.MIN_SAMPLES) continue

        const avgProb = data.sumProb / data.count
        const avgActual = data.sumActual / data.count

        // Bayesian shrinkage toward 1.0
        const shrinkage = data.count / (data.count + this.K_SHRINKAGE)
        const rawFactor = avgProb > 0 ? avgActual / avgProb : 1.0
        const correctedFactor = 1.0 + (rawFactor - 1.0) * shrinkage

        // Confidence score: more data + more recent = higher confidence
        const dataConfidence = Math.min(1.0, data.count / 50)
        const recencyBoost = data.recentCount > 0 ? 0.15 : 0
        const confidence = Math.min(1.0, dataConfidence + recencyBoost)

        this.biasCache.set(key, {
          factor: correctedFactor,
          confidence,
          count: data.count,
          recentCount: data.recentCount,
        })
      }
      this.lastUpdate = Date.now()
      logger.info(
        `[META-REFINER V3] Matrix updated: ${this.biasCache.size} active keys (from ${rows.length} records, cutoff: ${this.MAX_HISTORY_DAYS}d)`
      )
    } catch (e) {
      logger.error(`[META-REFINER V3] Refresh failed: ${e.message}`)
    }
  }

  /**
   * Refines probabilities based on historical bias.
   * V3: Now corrects all three outcomes (H/D/A) with confidence weighting.
   */
  async refine(match) {
    await this.refreshBiasMatrix()

    const refined = { ...match }
    const league = match.league || 'Unknown'

    // 1. Refine Home Win
    const hKey = `${league}|Home`
    if (this.biasCache.has(hKey)) {
      const { factor, confidence } = this.biasCache.get(hKey)
      // Only apply correction proportional to our confidence in the bias
      const adjustedFactor = 1.0 + (factor - 1.0) * confidence
      refined.home_win_probability = Math.min(
        99,
        Math.max(1, (match.home_win_probability || 0) * adjustedFactor)
      )
      refined.meta_correction_h = +adjustedFactor.toFixed(4)
    }

    // 2. Refine Draw
    const dKey = `${league}|Draw`
    if (this.biasCache.has(dKey)) {
      const { factor, confidence } = this.biasCache.get(dKey)
      const adjustedFactor = 1.0 + (factor - 1.0) * confidence
      refined.draw_probability = Math.min(
        99,
        Math.max(1, (match.draw_probability || match.draw_win_probability || 0) * adjustedFactor)
      )
      refined.meta_correction_d = +adjustedFactor.toFixed(4)
    }

    // 3. Refine Away Win
    const aKey = `${league}|Away`
    if (this.biasCache.has(aKey)) {
      const { factor, confidence } = this.biasCache.get(aKey)
      const adjustedFactor = 1.0 + (factor - 1.0) * confidence
      refined.away_win_probability = Math.min(
        99,
        Math.max(1, (match.away_win_probability || 0) * adjustedFactor)
      )
      refined.meta_correction_a = +adjustedFactor.toFixed(4)
    }

    // 4. Renormalize probabilities to sum to 100%
    const total =
      (refined.home_win_probability || 0) +
      (refined.draw_probability || 0) +
      (refined.away_win_probability || 0)
    if (total > 0 && Math.abs(total - 100) > 0.5) {
      const scale = 100 / total
      refined.home_win_probability = +(refined.home_win_probability * scale).toFixed(1)
      refined.draw_probability = +(refined.draw_probability * scale).toFixed(1)
      refined.away_win_probability = +(refined.away_win_probability * scale).toFixed(1)
      refined.meta_renormalized = true
    }

    return refined
  }

  /**
   * Get diagnostic info about the bias matrix for a league.
   */
  getLeagueDiagnostics(league) {
    const diagnostics = {}
    for (const [key, data] of this.biasCache) {
      if (key.startsWith(`${league}|`)) {
        diagnostics[key] = data
      }
    }
    return diagnostics
  }
}

module.exports = new NeuralMetaRefiner()
