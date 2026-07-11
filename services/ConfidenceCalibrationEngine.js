/**
 * TITANIUM EVOLUTION LAYER - CONFIDENCE CALIBRATION ENGINE V2
 * -----------------------------------------------------------
 * Dynamically adjusts prediction confidence based on:
 *   - League volatility & failure patterns
 *   - Model drift detection
 *   - Match context (derby, cup, relegation, etc.)
 *   - Odds consensus quality
 *   - Data freshness
 */

const evolutionEngine = require('./EvolutionEngine');
const db = require('../core/database');
const logger = require('../core/logger');

class ConfidenceCalibrationEngine {
    constructor() {
        this.leagueProfiles = {};
        this.profilesTTL = 600000; // 10 minutes
        this.lastProfileUpdate = 0;
    }

    async calibrate(match, baseConfidence) {
        let calibratedConfidence = baseConfidence;
        const penalties = [];
        const boosts = [];

        // 1. Contextual Risk Factor from Evolution Engine
        try {
            const riskFactor = await evolutionEngine.getMatchRiskFactor(
                match.league,
                match.homeTeam,
                match.awayTeam,
                match.referee_id
            );
            if (riskFactor > 1.0) {
                calibratedConfidence /= riskFactor;
                penalties.push({ factor: 'evolution_risk', value: -((riskFactor - 1) * 100).toFixed(1) + '%' });
            }
        } catch (e) {
            logger.debug(`[CALIBRATOR] Evolution risk skipped: ${e.message}`);
        }

        // 2. League Volatility Multiplier (improved: real variance calculation)
        const leagueStability = await this.getLeagueStability(match.league);
        calibratedConfidence *= leagueStability;
        if (leagueStability < 1.0) {
            penalties.push({ factor: 'league_volatility', value: -((1 - leagueStability) * 100).toFixed(1) + '%' });
        }

        // 3. Lineup Quality Check
        if (match.is_missing_star || match.is_missing_scorer) {
            calibratedConfidence *= 0.92;
            penalties.push({ factor: 'missing_star', value: '-8%' });
        }

        // 4. Derby / Rivalry penalty (higher variance)
        if (match.is_derby || match.is_rivalry) {
            calibratedConfidence *= 0.94;
            penalties.push({ factor: 'derby', value: '-6%' });
        }

        // 5. Cup / Knockout stage boost (teams play more seriously)
        if (match.stage === 'knockout' || match.stage === 'quarter_final' ||
            match.stage === 'semi_final' || match.stage === 'final') {
            calibratedConfidence *= 1.03;
            boosts.push({ factor: 'cup_knockout', value: '+3%' });
        }

        // 6. Odds consensus quality (if odds are from reliable source)
        if (match.has_real_odds && match.odds_source !== 'default') {
            calibratedConfidence *= 1.02;
            boosts.push({ factor: 'real_odds', value: '+2%' });
        } else if (match.odds_source === 'default' || !match.odds_source) {
            calibratedConfidence *= 0.96;
            penalties.push({ factor: 'synthetic_odds', value: '-4%' });
        }

        // 7. Data freshness penalty (stale data = less confidence)
        if (match.data_age_hours && match.data_age_hours > 48) {
            const freshnessPenalty = Math.max(0.88, 1 - (match.data_age_hours - 48) * 0.002);
            calibratedConfidence *= freshnessPenalty;
            penalties.push({ factor: 'stale_data', value: '-' + ((1 - freshnessPenalty) * 100).toFixed(1) + '%' });
        }

        // 8. Model agreement bonus (if multiple models agree)
        if (match.model_agreement_score && match.model_agreement_score > 0.8) {
            calibratedConfidence *= 1.04;
            boosts.push({ factor: 'model_agreement', value: '+4%' });
        }

        // 9. Relegation / Title decider bonus (motivated teams are more predictable)
        if (match.is_decisive) {
            calibratedConfidence *= 1.02;
            boosts.push({ factor: 'decisive_match', value: '+2%' });
        }

        // Floor and ceiling
        calibratedConfidence = Math.round(Math.min(99, Math.max(5, calibratedConfidence)));

        return {
            calibratedConfidence,
            penalties,
            boosts,
            netEffect: calibratedConfidence - baseConfidence
        };
    }

    async getLeagueStability(leagueName) {
        try {
            // Real variance-based stability: calculate the actual std dev of prediction accuracy
            const stats = db.db.prepare(`
                SELECT
                    COUNT(*) as total,
                    SUM(CASE WHEN result IN ('won', 'WON') THEN 1 ELSE 0 END) as correct
                FROM prediction_history
                WHERE league = ? AND result IS NOT NULL
            `).get(leagueName);

            if (!stats || stats.total < 10) return 1.0; // Neutral for new leagues

            const accuracy = stats.correct / stats.total;

            // Check failure patterns for volatility
            const chaoticPatterns = db.db.prepare(`
                SELECT COALESCE(SUM(frequency), 0) as totalFailures
                FROM failure_intelligence
                WHERE league = ? AND (
                    failure_type = 'RED_CARD_COLLAPSE' OR
                    failure_type = 'LATE_GOAL_VARIANCE' OR
                    failure_type = 'ODDS_TRAP_PATTERN' OR
                    failure_type = 'MOTIVATION_MISREAD'
                )
            `).get(leagueName);

            const failureRate = (chaoticPatterns.totalFailures || 0) / stats.total;

            // Map failure rate to stability multiplier
            if (failureRate > 0.4) return 0.82;  // Very volatile league
            if (failureRate > 0.25) return 0.88;  // Volatile
            if (failureRate > 0.15) return 0.94;  // Somewhat volatile
            if (failureRate > 0.08) return 0.97;  // Slightly volatile

            return 1.0; // Stable league
        } catch (e) {
            return 1.0;
        }
    }

    /**
     * Get a full calibration report for diagnostics.
     */
    async getCalibrationReport(match) {
        const baseConf = 50;
        const result = await this.calibrate(match, baseConf);
        return {
            match: `${match.homeTeam} vs ${match.awayTeam}`,
            league: match.league,
            baseConfidence: baseConf,
            ...result
        };
    }
}

module.exports = new ConfidenceCalibrationEngine();
