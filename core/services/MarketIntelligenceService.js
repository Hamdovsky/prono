/**
 * MarketIntelligenceService
 * يوحد تحليل السوق، الإشارات الذكية، وارتباطات الماركت.
 */

const sharpService = require('../../services/SharpIntelligenceService');
const correlationEngine = require('../../services/MarketCorrelationEngine');

class MarketIntelligenceService {
    async analyze(match, probabilities) {
        // 1. Sharp Betting & Market Energy Analysis
        const sharpAnalysis = sharpService.analyzeSharpSignals(match, probabilities);
        
        // 2. Market Correlation Analysis
        const correlation = await correlationEngine.analyze(match);

        // 3. Compute Odds Speed
        const oddsSpeed = {
            home: match.odds_analysis?.odds_change_speed_h || 0,
            away: match.odds_analysis?.odds_change_speed_a || 0,
            is_fast: (Math.abs(match.odds_analysis?.odds_change_speed_h || 0) > 0.1 || Math.abs(match.odds_analysis?.odds_change_speed_a || 0) > 0.1)
        };

        return {
            sharp_score: sharpAnalysis.sharp_score,
            market_signals: sharpAnalysis.signals,
            market_energy: sharpAnalysis.market_energy || 50,
            correlation: correlation,
            odds_speed: oddsSpeed
        };
    }

    applyMarketBoosts(match, intelligence) {
        let xgboost_confidence = match.xgboost_confidence;

        // Boost Confidence if Sharp Money aligns with AI
        if (intelligence.sharp_score >= 70 && xgboost_confidence > 0) {
            xgboost_confidence = Math.min(0.98, xgboost_confidence + 0.05);
        }

        // Boost overall confidence if correlation is elite
        if (intelligence.correlation && intelligence.correlation.master_confidence > xgboost_confidence * 100) {
            xgboost_confidence = intelligence.correlation.master_confidence / 100;
        }

        return xgboost_confidence;
    }
}

module.exports = new MarketIntelligenceService();
