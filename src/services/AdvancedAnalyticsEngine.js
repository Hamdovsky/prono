class AdvancedAnalyticsEngine {
    
    /**
     * 1️⃣ Referee vs Discipline Conflict 🟨
     * Evaluates if a strict referee is assigned to an undisciplined team.
     * @returns {object} { conflictScore: number, warning: string }
     */
    static calculateDisciplineConflict(homeStats, awayStats, refYellows = 0, refReds = 0) {
        // Normal ref averages are usually ~4.0 yellow, ~0.2 red
        const isStrictRef = refYellows > 5.0 || refReds > 0.3;
        
        const homeFouls = homeStats?.avgFouls || 10;
        const awayFouls = awayStats?.avgFouls || 10;
        const homeYellows = homeStats?.yellowCards ? (homeStats.yellowCards / (homeStats.matchesPlayed || 1)) : 2;
        const awayYellows = awayStats?.yellowCards ? (awayStats.yellowCards / (awayStats.matchesPlayed || 1)) : 2;

        const isHomeUndisciplined = homeFouls > 13 || homeYellows > 2.5;
        const isAwayUndisciplined = awayFouls > 13 || awayYellows > 2.5;

        let score = 0;
        let warning = null;

        if (isStrictRef && (isHomeUndisciplined || isAwayUndisciplined)) {
            score = 85; 
            warning = "🚨 STRICT REF vs AGGRESSIVE TEAM (High Card/Penalty Risk)";
        } else if (isStrictRef) {
            score = 60;
            warning = "⚠️ Strict Referee assigned.";
        }

        return { score, warning, details: { refYellows, homeYellows, awayYellows } };
    }

    /**
     * 2️⃣ Fatigue & Rest Mismatch 🔋
     * Calculates rest days based on raw form event timestamps.
     */
    static calculateRestMismatch(homeFormRaw, awayFormRaw, matchTimestamp) {
        const getDaysSinceLastMatch = (form) => {
            if (!Array.isArray(form) || form.length === 0) return 7; // Default 1 week
            // Form is usually chronological, last item is most recent, but we sort to be sure
            const timestamps = form.map(e => e.startTimestamp).filter(t => t);
            if (timestamps.length === 0) return 7;
            const lastMatchTs = Math.max(...timestamps);
            const diffSeconds = matchTimestamp - lastMatchTs;
            return Math.max(0, diffSeconds / 86400);
        };

        const homeRestDays = getDaysSinceLastMatch(homeFormRaw);
        const awayRestDays = getDaysSinceLastMatch(awayFormRaw);

        const diffString = (homeRestDays, awayRestDays) => {
            const diff = homeRestDays - awayRestDays;
            if (diff >= 3) return `🟢 Home Rest Advantage (+${diff.toFixed(1)} days)`;
            if (diff <= -3) return `🔴 Away Rest Advantage (${diff.toFixed(1)} days)`;
            return "⚪ Balanced Schedule";
        };

        return {
            homeRestDays: +homeRestDays.toFixed(1),
            awayRestDays: +awayRestDays.toFixed(1),
            advantage: diffString(homeRestDays, awayRestDays),
            isFatigueTrap: Math.abs(homeRestDays - awayRestDays) >= 4
        };
    }

    /**
     * 3️⃣ xG Regression (Statistical Luck) 🎯
     * Compares xG vs Actual Goals to detect over/under-performance.
     */
    static calculateXGRegression(formAverages) {
        if (!formAverages || !formAverages.avgGoals) return { status: 'NORMAL', delta: 0 };
        
        const goals = formAverages.avgGoals;
        const xg = formAverages.tw_xG_scored;
        const delta = goals - xg; // Positive = Lucky (Scoring without clear chances), Negative = Unlucky

        let status = 'NORMAL';
        let badge = '⚪';

        if (delta >= 0.7) {
            status = 'OVERPERFORMING (Lucky/Lethal)';
            badge = '🍀';
        } else if (delta <= -0.7) {
            status = 'UNDERPERFORMING (Unlucky/Wasteful)';
            badge = '📉'; // Due for positive regression
        }

        return { status, badge, delta: +delta.toFixed(2), xg, goals };
    }

    /**
     * 4️⃣ Odds Velocity (Steam Tracker) ♨️
     * Calculates rapid odds movement. 
     */
    static calculateOddsVelocity(openingOdds, currentOdds) {
        if (!openingOdds || !currentOdds || !openingOdds.odds_home_open || !currentOdds.home) {
            return { steamLevel: 0, trend: 'STABLE' };
        }

        const dropDiff = ((currentOdds.home - openingOdds.odds_home_open) / openingOdds.odds_home_open) * 100;
        
        let trend = 'STABLE';
        let steamLevel = 0; // 0-100

        if (dropDiff <= -10) {
            trend = '📉 MAJOR STEAM (Sharp Money)';
            steamLevel = Math.min(100, Math.abs(dropDiff) * 5); // 20% drop = 100 level
        } else if (dropDiff >= 10) {
            trend = '📈 FADING (Public Money against)';
            steamLevel = Math.min(100, Math.abs(dropDiff) * 3);
        }

        return { steamLevel: +steamLevel.toFixed(1), trend, diffPct: +dropDiff.toFixed(1) };
    }
}

module.exports = AdvancedAnalyticsEngine;
