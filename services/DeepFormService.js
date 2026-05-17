/**
 * DeepFormService (V33 Elite Expansion)
 * Simulates an LSTM-like temporal weighting for historical match form.
 * More recent matches carry significantly more weight in the momentum calculation.
 */

class DeepFormService {
    constructor() {
        // Temporal Weights (T=0 is most recent, T=4 is oldest)
        // Sum roughly equals 1.0 (0.35 + 0.25 + 0.20 + 0.12 + 0.08)
        this.weights = [0.35, 0.25, 0.20, 0.12, 0.08];
    }

    /**
     * Analyze a series of raw form events for a specific team.
     * @param {Array} events - Array of raw Sofascore past matches 
     * @param {string} teamId - The targeted team ID to determine home/away perspective
     * @returns {Object} Deep form metrics
     */
    analyzeForm(events, teamId) {
        if (!Array.isArray(events) || events.length === 0) {
            return {
                form_rating: 50,
                offensive_momentum: 50,
                defensive_stability: 50,
                trend: '↔️ Stable',
                trend_vector: 0
            };
        }

        const tid = String(teamId);
        
        let weightedPoints = 0;
        let weightedGoalsFor = 0;
        let weightedGoalsAgainst = 0;
        let weightedXgFor = 0;
        let weightedXgAgainst = 0;
        let totalWeight = 0;

        // Arrays to detect trend direction
        const formTrend = [];

        // Events are usually sorted newest to oldest. We process up to 5 events.
        const recentEvents = events.slice(0, 5);

        recentEvents.forEach((ev, index) => {
            const w = this.weights[index] || 0.05; // Fallback for matches beyond 5
            totalWeight += w;

            const isHome = String(ev.homeTeam?.id) === tid;
            
            // Goals
            const gs = isHome
                ? (ev.homeScore?.current ?? ev.homeScore?.normaltime ?? 0)
                : (ev.awayScore?.current ?? ev.awayScore?.normaltime ?? 0);
            const gc = isHome
                ? (ev.awayScore?.current ?? ev.awayScore?.normaltime ?? 0)
                : (ev.homeScore?.current ?? ev.homeScore?.normaltime ?? 0);

            // [VENUE WEIGHTING] Apply difficulty multipliers (Away win > Home win)
            const VENUE_MULT = isHome ? 0.9 : 1.25; 
            const DRAW_MULT = isHome ? 0.85 : 1.15;

            // Points with Venue Multiplier
            let pts = 0;
            if (gs > gc) pts = 3 * VENUE_MULT;
            else if (gs === gc) pts = 1 * DRAW_MULT;

            // Optional xG
            const xgS = isHome
                ? (ev.homeXg ?? ev.homeScore?.expectedGoals ?? gs)
                : (ev.awayXg ?? ev.awayScore?.expectedGoals ?? gs);
            const xgC = isHome
                ? (ev.awayXg ?? ev.awayScore?.expectedGoals ?? gc)
                : (ev.homeXg ?? ev.homeScore?.expectedGoals ?? gc);

            weightedPoints += (pts * w);
            weightedGoalsFor += (gs * w * (isHome ? 1.0 : 1.1)); // Slight bonus for away goals
            weightedGoalsAgainst += (gc * w * (isHome ? 1.1 : 1.0)); // Slight penalty for conceding at home
            weightedXgFor += (xgS * w);
            weightedXgAgainst += (xgC * w);

            // Store raw points for trend detection
            formTrend.push(pts);
        });

        // Normalize (in case totalWeight isn't exactly 1 due to < 5 matches)
        if (totalWeight > 0) {
            weightedPoints /= totalWeight;
            weightedGoalsFor /= totalWeight;
            weightedGoalsAgainst /= totalWeight;
            weightedXgFor /= totalWeight;
            weightedXgAgainst /= totalWeight;
        }

        // Calculate Ratings (0-100 scale)
        // Max weighted points is 3. So (Points / 3) * 100 is base rating.
        let form_rating = (weightedPoints / 3) * 100;

        // Offensive Momentum: Base 50. Each weighted goal > 1 adds roughly 15 pts.
        let offensive_momentum = 30 + (weightedXgFor * 25) + (weightedGoalsFor * 15);
        
        // Defensive Stability: Base 80. Each expected goal against drops it by 20.
        let defensive_stability = 90 - (weightedXgAgainst * 20) - (weightedGoalsAgainst * 10);

        // Bound to 0-100
        form_rating = Math.max(0, Math.min(100, form_rating));
        offensive_momentum = Math.max(0, Math.min(100, offensive_momentum));
        defensive_stability = Math.max(0, Math.min(100, defensive_stability));

        // Detect Trend (comparing newest 2 matches vs oldest 3)
        let trend = '↔️ Stable';
        let trend_vector = 0;

        if (formTrend.length >= 4) {
            const recentAvg = (formTrend[0] + formTrend[1]) / 2;
            const pastAvg = (formTrend[2] + formTrend[3]) / 2;
            trend_vector = recentAvg - pastAvg; // Positive means improving

            if (trend_vector > 0.8) trend = '🚀 On Fire';
            else if (trend_vector > 0.3) trend = '📈 Improving';
            else if (trend_vector < -0.8) trend = '📉 Collapsing';
            else if (trend_vector < -0.3) trend = '⚠️ Declining';
        }

        return {
            form_rating: Math.round(form_rating),
            offensive_momentum: Math.round(offensive_momentum),
            defensive_stability: Math.round(defensive_stability),
            trend,
            trend_vector: +trend_vector.toFixed(2),
            raw_weighted_pts: +weightedPoints.toFixed(2)
        };
    }

    /**
     * Compute the full Form Context for a match given both teams' metrics.
     */
    evaluateMatchForm(homeRawEvents, awayRawEvents, homeTeamId, awayTeamId) {
        const homeDeep = this.analyzeForm(homeRawEvents, homeTeamId);
        const awayDeep = this.analyzeForm(awayRawEvents, awayTeamId);

        // Calculate Form Differential
        const form_diff = homeDeep.form_rating - awayDeep.form_rating;

        // Synergy (e.g. High Offense vs Low Defense)
        // Does Home Offense completely overpower Away Defense?
        const home_attack_advantage = homeDeep.offensive_momentum - awayDeep.defensive_stability;
        const away_attack_advantage = awayDeep.offensive_momentum - homeDeep.defensive_stability;

        return {
            home: homeDeep,
            away: awayDeep,
            form_diff: Math.round(form_diff),
            home_attack_advantage: Math.round(home_attack_advantage),
            away_attack_advantage: Math.round(away_attack_advantage)
        };
    }
}

module.exports = new DeepFormService();
