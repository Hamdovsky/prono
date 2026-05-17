/**
 * TacticalEVCalculator.js
 * ─────────────────────────────────────────────────────────────
 * Tactical EV Optimizer (محرك القيمة التكتيكي المعدل)
 * Integrates Player Impact, Real-Market Odds, and xG Trends.
 * ─────────────────────────────────────────────────────────────
 */

class TacticalEVCalculator {
    constructor() {
        this.STAR_PENALTY = 0.88;    // -12% for Elite Scorer
        this.SQUAD_PENALTY = 0.98;   // -2% for Squad players
        this.XG_TREND_BONUS = 0.05;  // +5% EV bonus for xG↑
    }

    /**
     * Calculates Adjusted Probability based on SQUAD health.
     * @param {number} baseProb - Base win probability (0-100)
     * @param {object} squadImpact - { home_attack_impact, away_defense_impact, etc }
     * @returns {number} Adjusted probability (0-100)
     */
    getAdjustedProb(baseProb, squadImpact) {
        if (!squadImpact) return baseProb;

        // Logic: Apply penalties based on impact coefficients
        // If attack_impact is < 1.0, it means players are missing.
        // We assume the impact service already calculated the coefficient.
        // The user specifically asked for: -12% for scorers (elite), -2% for squad.
        // Our PlayerImpactService already uses 0.88 for elite and 0.94 for star.
        
        let multiplier = 1.0;
        
        // Use the pre-calculated coefficients from the DB/Service
        // home_attack_impact directly acts as our multiplier for scoring threat
        if (squadImpact.home_attack_impact < 1.0) {
            multiplier *= squadImpact.home_attack_impact;
        }

        // If the away defense is stronger (coeff < 1.0), it further reduces home win prob?
        // Actually, defense_impact > 1.0 means defense is WEAKER (conceding more).
        // So home win prob INCREASES if away defense is weak (> 1.0)
        if (squadImpact.away_defense_impact > 1.0) {
            // If away defense is 1.12 (missing GK), home prob gets a boost
            multiplier *= (squadImpact.away_defense_impact * 0.5 + 0.5); // Smoothed boost
        }

        const adjusted = baseProb * multiplier;
        return parseFloat(Math.min(100, Math.max(0, adjusted)).toFixed(1));
    }

    /**
     * Removes bookmaker margin to find the "Fair Price".
     * @param {number} h - Home odds
     * @param {number} d - Draw odds
     * @param {number} a - Away odds
     * @returns {object} { fairH, fairD, fairA, margin }
     */
    getFairProbabilities(h, d, a) {
        if (!h || !a) return null;
        const implH = (1 / h) * 100;
        const implD = d ? (1 / d) * 100 : 0;
        const implA = (1 / a) * 100;

        const overround = implH + implD + implA;
        if (overround <= 0) return null;

        return {
            home: (implH / overround) * 100,
            draw: (implD / overround) * 100,
            away: (implA / overround) * 100,
            margin: overround - 100
        };
    }

    /**
     * Main Tactical EV Logic
     * @param {number} adjProb - Adjusted Win Prob (0-100)
     * @param {number} marketOdds - Decimal odds
     * @param {boolean} xgTrendingUp - If xG trend is up
     * @returns {object} { ev, isHighValue, bonusApplied }
     */
    calculateTacticalEV(adjProb, marketOdds, xgTrendingUp) {
        if (!adjProb || !marketOdds || marketOdds <= 1) return { ev: 0, isHighValue: false };

        const p = adjProb / 100;
        let ev = (p * marketOdds) - 1;

        let bonusApplied = false;
        if (xgTrendingUp) {
            ev += this.XG_TREND_BONUS;
            bonusApplied = true;
        }

        return {
            ev: parseFloat((ev * 100).toFixed(2)), // in %
            isHighValue: (ev * 100) > 15,
            bonusApplied
        };
    }
}

module.exports = new TacticalEVCalculator();
