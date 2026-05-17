/**
 * TacticalValueEngine.js
 * ─────────────────────────────────────────────────────────────
 * Tactical EV Optimizer (محرك القيمة التكتيكي المعدل)
 * Author: Stitch Quant Engine
 * ─────────────────────────────────────────────────────────────
 */

class TacticalValueEngine {
    constructor() {
        this.XG_BONUS = 5; // +5% additive boost
        this.JUICE_ESTIMATE = 0.95; // 5% margin removal
    }

    /**
     * Calculates the Adjusted Expected Value (EV).
     * @param {number} baseWinProb - Initial AI probability (0-100)
     * @param {number} newsImpact - Score from -100 to +100
     * @param {string} xgTrend - 'UP', 'DOWN', 'STABLE'
     * @param {number} marketOdds - Decimal odds from Sofascore
     * @param {string} id - Match ID for logging
     * @returns {object} { adjustedProb, evPercentage, signal, KellyCriterion }
     */
    calculateEV(baseWinProb, newsImpact, xgTrend, marketOdds, id = 'UNKNOWN') {
        console.log(`[VAL_ENGINE] Calculating for Match ID: ${id}...`);

        if (!baseWinProb || !marketOdds || marketOdds <= 1) {
            return { adjustedProb: 0, evPercentage: 0, signal: '⚠️', KellyCriterion: 0 };
        }

        // 1. Probability Adjustment (Linear weight)
        // Final_Prob = baseWinProb * (1 + (newsImpact / 100))
        let finalProb = baseWinProb * (1 + (newsImpact / 100));

        // 2. Trend Momentum
        // If xgTrend === 'UP', add a fixed +5% boost to the Final_Prob
        if (xgTrend === 'UP') {
            finalProb += this.XG_BONUS;
        }

        // Clamp prob between 1 and 99%
        finalProb = Math.min(99, Math.max(1, finalProb));

        // 3. Margin Removal (Fair Odds)
        // Fair_Odds = 1 / (1 / marketOdds * 0.95)
        const fairOdds = 1 / ((1 / marketOdds) * this.JUICE_ESTIMATE);

        // 4. EV Calculation (using market odds)
        // EV = (Final_Prob * marketOdds) - 1
        const pNormalized = finalProb / 100;
        const ev = (pNormalized * marketOdds) - 1;
        const evPercentage = parseFloat((ev * 100).toFixed(2));

        // 5. Signal Logic
        let signal = '⚠️';
        if (evPercentage > 20 && newsImpact > 10) signal = '💎 ULTRA-VALUE';
        else if (evPercentage > 15) signal = '🔥';
        else if (evPercentage > 5) signal = '🎯';

        // 6. Kelly Criterion
        // Kelly = ((Odds * Prob) - 1) / (Odds - 1)
        let kelly = 0;
        if (ev > 0) {
            kelly = ((marketOdds * pNormalized) - 1) / (marketOdds - 1);
            // Apply 0.25 fractional Kelly to be safe
            kelly = parseFloat((kelly * 0.25 * 100).toFixed(2));
        }

        return {
            adjustedProb: parseFloat(finalProb.toFixed(2)),
            evPercentage,
            signal,
            KellyCriterion: Math.max(0, kelly)
        };
    }
}

// Export a singleton instance and a convenience function for _enrich_news.js
const engine = new TacticalValueEngine();

module.exports = {
    engine,
    calculateTacticalValue: (matchId, baseProb, impact, trend, odds) => {
        return engine.calculateEV(baseProb, impact, trend, odds, matchId);
    }
};
