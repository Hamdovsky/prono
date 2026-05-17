/**
 * 🎯 TITANIUM EVOLUTION LAYER - CONFIDENCE CALIBRATION ENGINE
 * -----------------------------------------------------------
 * Dynamically adjusts prediction confidence based on league volatility,
 * historical failure patterns, and model drift.
 */

const evolutionEngine = require('./EvolutionEngine');
const db = require('../core/database');

class ConfidenceCalibrationEngine {
    constructor() {
        this.leagueProfiles = {};
    }

    async calibrate(match, baseConfidence) {
        let calibratedConfidence = baseConfidence;

        // 1. Contextual Risk Factor from Evolution Engine
        const riskFactor = await evolutionEngine.getMatchRiskFactor(
            match.league, 
            match.homeTeam, 
            match.awayTeam, 
            match.referee_id
        );

        // 2. League Volatility Multiplier
        const leagueStability = await this.getLeagueStability(match.league);
        
        // Apply penalties
        calibratedConfidence = calibratedConfidence / riskFactor;
        calibratedConfidence = calibratedConfidence * leagueStability;

        // 3. Lineup Quality Check (Penalty if missing key players)
        if (match.is_missing_star || match.is_missing_scorer) {
            calibratedConfidence *= 0.92;
        }

        return Math.round(Math.min(99, calibratedConfidence));
    }

    async getLeagueStability(leagueName) {
        // Simple stability index based on historical strike rate in this league
        try {
            const stats = await db.prepare(`
                SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN scoreHome IS NOT NULL THEN 1 ELSE 0 END) as finished
                FROM matches 
                WHERE league = ?
            `).get(leagueName);

            if (!stats || stats.finished < 10) return 1.0; // Neutral for new leagues

            // In a real scenario, we'd calculate the actual Strike Rate here.
            // For now, let's look for "Chaotic" patterns in failure intelligence.
            const chaoticPatterns = await db.prepare(`
                SELECT SUM(frequency) as totalFailures
                FROM failure_intelligence
                WHERE league = ? AND (failure_type = 'RED_CARD_COLLAPSE' OR failure_type = 'LATE_GOAL_VARIANCE')
            `).get(leagueName);

            const failureLevel = chaoticPatterns.totalFailures || 0;
            if (failureLevel > 20) return 0.85; // Very volatile
            if (failureLevel > 10) return 0.92; // Volatile
            
            return 1.0;
        } catch (e) {
            return 1.0;
        }
    }
}

module.exports = new ConfidenceCalibrationEngine();
