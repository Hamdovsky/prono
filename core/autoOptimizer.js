const fs = require('fs')
const path = require('path')
const db = require('./database')
const logger = require('./logger')

// draw_bias = multiplicateur de tendance nulle : 1.0 = neutre. confidenceScorer
// sature dès ~1.6 (plafonds -10/+5 pts) ; au-delà, += 0.15 sans plafond (bug
// historique : 65.65 en production) ne change rien sauf à rendre toute
// auto-optimisation mono-directionnelle. Bornes + retour neutre imposés ici.
const DRAW_BIAS_MIN = 1.0
const DRAW_BIAS_MAX = 1.6

class AutoOptimizationEngine {
  constructor() {
    this.configPath = path.join(__dirname, '../config/model_weights.json')
    this.weights = this._loadWeights()
    this._sanitizeWeights()
  }

  _clampDrawBias(value = this.weights.draw_bias) {
    const raw = Number(value)
    const safe = Number.isFinite(raw) ? raw : DRAW_BIAS_MIN
    return Math.min(DRAW_BIAS_MAX, Math.max(DRAW_BIAS_MIN, safe))
  }

  // Valeurs héritées hors plage (ex. draw_bias 65.65) corrigées et repersistées
  // au chargement — sinon confidenceScorer resterait saturé malgré le clamp.
  _sanitizeWeights() {
    const clamped = this._clampDrawBias()
    if (clamped !== this.weights.draw_bias) {
      logger.warn(
        `🧹 [AUTO-OPT] draw_bias=${this.weights.draw_bias} hors plage [${DRAW_BIAS_MIN}, ${DRAW_BIAS_MAX}] -> clampé à ${clamped}.`
      )
      this.weights.draw_bias = clamped
      fs.writeFileSync(this.configPath, JSON.stringify(this.weights, null, 2))
    }
  }

  _loadWeights() {
    try {
      if (!fs.existsSync(this.configPath)) {
        const defaults = { poisson_xg_weight: 1.0, bsm_threshold: 25, draw_bias: 1.0 }
        fs.writeFileSync(this.configPath, JSON.stringify(defaults, null, 2))
        return defaults
      }
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
    } catch (e) {
      logger.warn(`[AUTO-OPT] Failed to load weights: ${e.message}`)
      return { poisson_xg_weight: 1.0, bsm_threshold: 25, draw_bias: 1.0 }
    }
  }

  _isFallback(m) {
    const q = m.quant || {}
    const hp = parseFloat(q.home_win_probability ?? m.home_win_probability ?? -1)
    const dp = parseFloat(q.draw_probability ?? m.draw_probability ?? -1)
    const ap = parseFloat(q.away_win_probability ?? m.away_win_probability ?? -1)
    if (hp < 0 || dp < 0 || ap < 0) return false
    // distribution aveugle 33% → fallback
    const eps = 0.02
    return Math.abs(hp - 1 / 3) < eps && Math.abs(dp - 1 / 3) < eps && Math.abs(ap - 1 / 3) < eps
  }

  async optimizeModelBasedOnROI() {
    logger.info('🤖 [AUTO-OPT] Analysing past results to self-heal...')

    let pastMatches = await db.getRecentArchivedMatches(50)
    const totalRaw = pastMatches.length
    pastMatches = pastMatches.filter((m) => !this._isFallback(m))
    const filteredOut = totalRaw - pastMatches.length
    if (filteredOut > 0)
      logger.info(
        `🧹 [AUTO-OPT] Filtered out ${filteredOut} fallback matches (blind 33% distribution).`
      )

    if (pastMatches.length < 10) {
      logger.info(
        `📉 [AUTO-OPT] Not enough valid matches (${pastMatches.length}/${totalRaw}) to optimize.`
      )
      return
    }

    let totalSolidWins = 0
    let totalSolidMatches = 0
    let missedDraws = 0

    for (const m of pastMatches) {
      const q = m.quant || {}
      const baseSolidMargin = q.base_solid_margin || m.base_solid_margin || 0
      const mainPick = q.main_pick || m.main_pick || ''
      const drawProb = parseFloat(q.draw_probability ?? m.draw_probability ?? 0)
      const scoreHome = parseInt(m.scoreHome ?? 0)
      const scoreAway = parseInt(m.scoreAway ?? 0)
      const actualResult = scoreHome > scoreAway ? '1' : scoreHome === scoreAway ? 'X' : '2'

      const isSolid = parseFloat(baseSolidMargin) > 0
      if (isSolid) {
        totalSolidMatches++
        if (mainPick === actualResult) totalSolidWins++
      }

      if (actualResult === 'X' && mainPick !== 'X' && drawProb < 30) {
        missedDraws++
      }
    }

    const solidSuccessRate =
      totalSolidMatches > 0 ? (totalSolidWins / totalSolidMatches) * 100 : 100

    let updated = false

    if (solidSuccessRate < 70 && this.weights.bsm_threshold < 40) {
      this.weights.bsm_threshold += 5
      logger.warn(
        `⚠️ [AUTO-OPT] Solid win rate dropped to ${solidSuccessRate.toFixed(1)}%. Raising BSM Threshold to ${this.weights.bsm_threshold}% for safety.`
      )
      updated = true
    }

    const prevBias = this.weights.draw_bias
    if (missedDraws > 5) {
      this.weights.draw_bias = this._clampDrawBias(
        Math.min(DRAW_BIAS_MAX, prevBias + 0.15)
      )
      logger.warn(
        `💣 [AUTO-OPT] Too many missed draws detected (${missedDraws}). Increasing Draw Bias to ${this.weights.draw_bias.toFixed(2)} (max ${DRAW_BIAS_MAX}).`
      )
      updated = true
    } else if (missedDraws <= 2 && prevBias > DRAW_BIAS_MIN) {
      // décrément symétrique : retour progressif vers la neutralité (1.0)
      this.weights.draw_bias = Math.max(DRAW_BIAS_MIN, Number((prevBias - 0.05).toFixed(2)))
      logger.info(
        `🧊 [AUTO-OPT] Few missed draws (${missedDraws}). Cooling Draw Bias down to ${this.weights.draw_bias.toFixed(2)}.`
      )
      updated = true
    }
    if (this.weights.draw_bias > DRAW_BIAS_MAX) this.weights.draw_bias = DRAW_BIAS_MAX

    if (solidSuccessRate > 85 && this.weights.bsm_threshold > 20) {
      this.weights.bsm_threshold -= 2
      logger.info(
        `📈 [AUTO-OPT] Solid win rate is ${solidSuccessRate.toFixed(1)}%. Lowering BSM Threshold to ${this.weights.bsm_threshold}.`
      )
      updated = true
    }

    if (updated) {
      fs.writeFileSync(this.configPath, JSON.stringify(this.weights, null, 2))
      logger.info('✅ [AUTO-OPT] Model weights self-healed and updated successfully.')
    } else {
      logger.info(
        `✅ [AUTO-OPT] No adjustments needed. Win rate: ${solidSuccessRate.toFixed(1)}% (${totalSolidWins}/${totalSolidMatches}), missed draws: ${missedDraws}`
      )
    }
  }

  safeGuardPrediction(match, rawPrediction) {
    if (!match.home_win_probability || isNaN(parseFloat(match.home_win_probability))) {
      logger.error(
        `🚨 [AUTO-OPT] Bug detected on match ${match.homeTeam}. Auto-fixing with equal distribution fallback.`
      )
      return {
        main_pick: '1X',
        home_win_probability: 33.3,
        draw_probability: 33.3,
        away_win_probability: 33.3,
        base_solid_margin: 0,
      }
    }
    return rawPrediction
  }
}

module.exports = new AutoOptimizationEngine()
