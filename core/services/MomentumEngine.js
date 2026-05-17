const database = require('../database');
const logger = require('../logger');

class MomentumEngine {
    /**
     * Calculates the "Trend Factor" for a team based on their last 3 matches in the learning memory.
     * @param {string} teamName 
     * @returns {number} 1.0 (Neutral), > 1.0 (Hot), < 1.0 (Cold)
     */
    getTrend(teamName) {
        if (!teamName) return 1.0;
        try {
            const db = database.db;
            const matches = db.prepare(`
                SELECT actual, score, error_type 
                FROM learning_memory 
                WHERE (home_team = ? OR away_team = ?) 
                ORDER BY match_date DESC LIMIT 3
            `).all(teamName, teamName);

            if (matches.length < 2) return 1.0; // Not enough data for a trend

            let points = 0;
            matches.forEach(m => {
                const isHome = (m.home_team === teamName);
                if (m.actual === 'D') points += 1;
                else if ((isHome && m.actual === 'H') || (!isHome && m.actual === 'A')) points += 3;
            });

            // Scoring Logic:
            // 9 pts (3 wins) -> 1.15 boost
            // 7 pts -> 1.10
            // 0-1 pts -> 0.85 penalty
            if (points >= 9) return 1.15;
            if (points >= 7) return 1.10;
            if (points <= 1) return 0.85;
            if (points <= 2) return 0.92;

            return 1.0;
        } catch (e) {
            return 1.0;
        }
    }

    /**
     * Specialized HT Momentum
     */
    getHTMomentum(teamName) {
        // Boost HT if the team often scores in the first half (simulated via trend for now)
        const trend = this.getTrend(teamName);
        return trend > 1 ? (1 + (trend - 1) * 1.5) : trend;
    }
}

module.exports = new MomentumEngine();
