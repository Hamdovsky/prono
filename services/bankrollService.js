/**
 * BankrollService.js — V90 Portfolio & Bankroll Management
 * ───────────────────────────────────────────────────────
 * Uses the Fractional Kelly Criterion to suggest optimal bet sizing
 * based on the AI's predicted probability (confidence) and market odds.
 */

class BankrollService {
    constructor() {
        // Fractional Kelly multiplier. 
        // A full Kelly (1.0) is mathematically optimal for growth but highly volatile.
        // A 0.25 multiplier (Quarter Kelly) is widely considered the industry standard 
        // to balance rapid growth with minimal risk of ruin.
        this.KELLY_MULTIPLIER = 0.25; 
        
        // Safety cap: Never advise risking more than 5% of bankroll on a single match.
        this.MAX_BET_PERCENTAGE = 0.05; 
    }

    /**
     * Calculate optimal bet percentage based on Kelly Criterion
     * Formula: f* = (p * b - q) / b
     * where:
     * f* = fraction of the current bankroll to wager
     * b = net fractional odds received on the wager (Decimal Odds - 1)
     * p = probability of winning (AI Confidence)
     * q = probability of losing (1 - p)
     * 
     * @param {number} probability - AI's estimated probability of winning (0 to 1)
     * @param {number} decimalOdds - Market decimal odds (e.g., 2.10)
     * @returns {Object} { recommendedPercentage, riskLevel, explanationAr }
     */
    calculateOptimalBet(probability, decimalOdds) {
        if (!probability || !decimalOdds || decimalOdds <= 1) {
            return {
                recommendedPercentage: 0,
                riskLevel: 'NO_BET',
                explanationAr: "لا توجد قيمة مراهنة. العوائد المتوقعة سلبية."
            };
        }

        const b = decimalOdds - 1;
        const p = probability;
        const q = 1 - p;

        // Calculate Full Kelly Fraction
        const f_star = (p * b - q) / b;

        // If f_star is negative, the model predicts a negative expected value (EV < 0). Do not bet.
        if (f_star <= 0) {
            return {
                recommendedPercentage: 0,
                riskLevel: 'NO_BET',
                explanationAr: "تجاوز هذه المراهنة. الخوارزمية لا ترى أي قيمة رياضية (EV سلبي)."
            };
        }

        // Apply Fractional Kelly (Quarter Kelly) for safety
        let fractionalKelly = f_star * this.KELLY_MULTIPLIER;

        // Apply safety cap
        fractionalKelly = Math.min(fractionalKelly, this.MAX_BET_PERCENTAGE);

        // Convert to percentage
        const recommendedPercentage = +(fractionalKelly * 100).toFixed(2);

        // Classify Risk Level and generate Arabic explanation
        let riskLevel = 'LOW';
        let explanationAr = `مخاطرة منخفضة جدًا. ننصح برهان بقيمة ${recommendedPercentage}% من رأس مالك.`;

        if (recommendedPercentage >= 4.0) {
            riskLevel = 'MAX_VALUE';
            explanationAr = `قيمة استثنائية! رهان قوي بقيمة ${recommendedPercentage}% من إجمالي المحفظة.`;
        } else if (recommendedPercentage >= 2.5) {
            riskLevel = 'HIGH_VALUE';
            explanationAr = `قيمة ممتازة. ننصح بالمراهنة بحوالي ${recommendedPercentage}% من رأس المال.`;
        } else if (recommendedPercentage >= 1.0) {
            riskLevel = 'MODERATE';
            explanationAr = `رهان معتدل. القيمة المضافة تتطلب استثمار ${recommendedPercentage}% من الرصيد.`;
        } else {
            riskLevel = 'LOW';
            explanationAr = `مخاطر عالية وقيمة منخفضة. ننصح برهان صغير بقيمة ${recommendedPercentage}% فقط للمتابعة.`;
        }

        return {
            recommendedPercentage,
            riskLevel,
            explanationAr,
            metrics: {
                ai_probability: p,
                implied_probability: 1 / decimalOdds,
                edge: (p - (1 / decimalOdds)) * 100,
                kelly_fraction: f_star
            }
        };
    }
}

module.exports = new BankrollService();
