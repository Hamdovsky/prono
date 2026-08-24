/**
 * MarketIntelligenceService
 * يوحد تحليل السوق، الإشارات الذكية، وارتباطات الماركت.
 */

const sharpService = require('../../services/SharpIntelligenceService')
const correlationEngine = require('../../services/MarketCorrelationEngine')
const logger = require('../logger')

class MarketIntelligenceService {
  async analyze(match, probabilities) {
    // 1. Sharp Betting & Market Energy Analysis
    const sharpAnalysis = sharpService.analyzeSharpSignals(match, probabilities)

    // 2. Market Correlation Analysis
    const correlation = await correlationEngine.analyze(match)

    // 3. Compute Odds Speed
    const oddsSpeed = {
      home: match.odds_analysis?.odds_change_speed_h || 0,
      away: match.odds_analysis?.odds_change_speed_a || 0,
      is_fast:
        Math.abs(match.odds_analysis?.odds_change_speed_h || 0) > 0.1 ||
        Math.abs(match.odds_analysis?.odds_change_speed_a || 0) > 0.1,
    }

    return {
      sharp_score: sharpAnalysis.sharp_score,
      market_signals: sharpAnalysis.signals,
      market_energy: sharpAnalysis.market_energy || 50,
      correlation: correlation,
      odds_speed: oddsSpeed,
    }
  }

  applyMarketBoosts(match, intelligence) {
    const original = match.xgboost_confidence
    let xgboost_confidence = original
    const contributions = []

    // Boost si sharp money aligné — plafonné à +0.02 (audit P1b : l'ancien
    // +0.05 arbitraire recréait de la sur-confiance). Chaque boost est logué.
    if (intelligence.sharp_score >= 70 && xgboost_confidence > 0) {
      const before = xgboost_confidence
      xgboost_confidence = Math.min(0.98, xgboost_confidence + 0.02)
      contributions.push({
        factor: 'sharp_money',
        sharp_score: intelligence.sharp_score,
        before: +before.toFixed(4),
        after: +xgboost_confidence.toFixed(4),
        delta: +(xgboost_confidence - before).toFixed(4),
      })
    }

    // Rattrapage vers master_confidence — progression plafonnée à +0.02/appel
    // (audit P1b : l'ancien saut direct vers master_confidence pouvait ajouter
    // +0.20 d'un coup). Chaque rattrapage est logué.
    if (
      intelligence.correlation &&
      intelligence.correlation.master_confidence > xgboost_confidence * 100
    ) {
      const before = xgboost_confidence
      const target = intelligence.correlation.master_confidence / 100
      xgboost_confidence = Math.min(0.98, Math.min(before + 0.02, target))
      contributions.push({
        factor: 'correlation_master',
        master_confidence: intelligence.correlation.master_confidence,
        target: +target.toFixed(4),
        before: +before.toFixed(4),
        after: +xgboost_confidence.toFixed(4),
        delta: +(xgboost_confidence - before).toFixed(4),
      })
    }

    if (contributions.length > 0) {
      logger.info(
        `[MARKET_BOOST] ${match?.id ?? match?.homeTeam ?? 'match'} confiance ${original?.toFixed ? original.toFixed(3) : original} -> ${xgboost_confidence.toFixed(3)} boosts=${JSON.stringify(contributions)}`
      )
    }

    return xgboost_confidence
  }
}

module.exports = new MarketIntelligenceService()
