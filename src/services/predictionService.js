/**
 * Prediction Service
 * Generates Over/Under, BTTS, and First Half Goal predictions
 * based on last 5 matches statistics
 */

class PredictionService {
    constructor() {
        this.cache = new Map();
    }

    /**
     * Generate predictions for a match based on team statistics
     * @param {Object} match - Match object with homeTeam, awayTeam, and stats
     * @returns {Object} Predictions object with over/under, btts, and htGoal
     */
    generatePredictions(match) {
        const { homeTeam, awayTeam, stats = {} } = match;

        // Extract team names (handle both string and object formats)
        const homeTeamName = typeof homeTeam === 'object' ? homeTeam.name : homeTeam;
        const awayTeamName = typeof awayTeam === 'object' ? awayTeam.name : awayTeam;

        // Get last 5 matches stats (now uses real data if available)
        const homeStats = this._getTeamStats(homeTeamName, homeTeam);
        const awayStats = this._getTeamStats(awayTeamName, awayTeam);

        // Calculate predictions
        const overUnder = this._predictOverUnder(homeStats, awayStats);
        const btts = this._predictBTTS(homeStats, awayStats);
        const htGoal = this._predictFirstHalfGoal(homeStats, awayStats);

        return {
            overUnder,
            btts,
            htGoal,
            stats: {
                home: homeStats,
                away: awayStats
            }
        };
    }

    /**
     * Predict Over/Under 2.5 goals
     */
    _predictOverUnder(homeStats, awayStats) {
        const avgGoals = (homeStats.avgGoals + awayStats.avgGoals) / 2;
        const avgGoalsConceded = (homeStats.avgGoalsConceded + awayStats.avgGoalsConceded) / 2;
        const totalAvg = (avgGoals + avgGoalsConceded) / 2;

        let prediction, confidence;

        if (totalAvg >= 2.8) {
            prediction = 'OVER_2_5';
            confidence = Math.min(95, Math.round(60 + (totalAvg - 2.8) * 20));
        } else if (totalAvg <= 2.2) {
            prediction = 'UNDER_2_5';
            confidence = Math.min(95, Math.round(60 + (2.2 - totalAvg) * 20));
        } else {
            // Between 2.2 and 2.8 - medium confidence
            prediction = totalAvg > 2.5 ? 'OVER_2_5' : 'UNDER_2_5';
            confidence = Math.round(50 + Math.abs(totalAvg - 2.5) * 10);
        }

        return {
            prediction,
            confidence,
            avgGoals: totalAvg.toFixed(2),
            reasoning: `Moyenne de ${totalAvg.toFixed(1)} buts sur les 5 derniers matchs`
        };
    }

    /**
     * Predict Both Teams To Score
     */
    _predictBTTS(homeStats, awayStats) {
        const homeBttsPercent = homeStats.bttsPercent;
        const awayBttsPercent = awayStats.bttsPercent;
        const avgBtts = (homeBttsPercent + awayBttsPercent) / 2;

        let prediction, confidence;

        if (avgBtts >= 70) {
            prediction = 'BTTS_YES';
            confidence = Math.min(95, Math.round(avgBtts));
        } else if (avgBtts <= 30) {
            prediction = 'BTTS_NO';
            confidence = Math.min(95, Math.round(100 - avgBtts));
        } else {
            // Medium confidence
            prediction = avgBtts >= 50 ? 'BTTS_YES' : 'BTTS_NO';
            confidence = Math.round(50 + Math.abs(avgBtts - 50) * 0.5);
        }

        return {
            prediction,
            confidence,
            bttsPercent: avgBtts.toFixed(0),
            reasoning: `${avgBtts.toFixed(0)}% des matchs avec les 2 équipes marquant`
        };
    }

    /**
     * Predict First Half Goal
     */
    _predictFirstHalfGoal(homeStats, awayStats) {
        const avgHtGoals = (homeStats.avgHtGoals + awayStats.avgHtGoals) / 2;
        const htGoalPercent = (homeStats.htGoalPercent + awayStats.htGoalPercent) / 2;

        let prediction, confidence;

        if (avgHtGoals >= 1.2 || htGoalPercent >= 75) {
            prediction = 'HT_GOAL_YES';
            confidence = Math.min(95, Math.round(60 + avgHtGoals * 15));
        } else if (avgHtGoals <= 0.6 || htGoalPercent <= 40) {
            prediction = 'HT_GOAL_NO';
            confidence = Math.min(95, Math.round(60 + (1 - avgHtGoals) * 20));
        } else {
            prediction = avgHtGoals >= 0.9 ? 'HT_GOAL_YES' : 'HT_GOAL_NO';
            confidence = Math.round(50 + Math.abs(avgHtGoals - 0.9) * 20);
        }

        return {
            prediction,
            confidence,
            avgHtGoals: avgHtGoals.toFixed(2),
            htGoalPercent: htGoalPercent.toFixed(0),
            reasoning: `Moyenne de ${avgHtGoals.toFixed(1)} buts en 1ère MT (${htGoalPercent.toFixed(0)}% des matchs)`
        };
    }

    /**
     * Get team statistics from last 5 matches
     * Now uses real data from the scraper/match object
     */
    /**
     * Get team statistics from last 5 matches
     * Now uses real data from the scraper/match object
     */
    _getTeamStats(teamName, teamData) {
        // If team data includes history from scraper, use it
        if (teamData && teamData.history) {
            return {
                teamName,
                lastMatches: teamData.history.lastMatches || this._generateMockMatches(teamName, 5),
                avgGoals: parseFloat(teamData.history.avgGoals) || 1.5,
                avgGoalsConceded: parseFloat(teamData.history.avgGoalsConceded) || 1.2,
                avgHtGoals: parseFloat(teamData.history.avgHtGoals) || 0.8,
                bttsPercent: parseFloat(teamData.history.bttsPercent) || 60,
                htGoalPercent: parseFloat(teamData.history.htGoalPercent) || 70
            };
        }

        // Fallback to cache or mock data
        if (this.cache.has(teamName)) {
            return this.cache.get(teamName);
        }

        // Generate mock stats if no real data (essential for simulated matches)
        const stats = this._generateMockStats(teamName);
        this.cache.set(teamName, stats);
        return stats;
    }

    /**
     * Generate mock statistics for demonstration
     * This will be replaced with real data from API
     */
    _generateMockStats(teamName) {
        // Generate semi-random but realistic stats
        const seed = teamName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
        const random = (min, max) => {
            const x = Math.sin(seed) * 10000;
            return min + (x - Math.floor(x)) * (max - min);
        };

        return {
            teamName,
            lastMatches: this._generateMockMatches(teamName, 5),
            avgGoals: random(1.0, 2.5),
            avgGoalsConceded: random(0.8, 2.0),
            avgHtGoals: random(0.4, 1.3),
            bttsPercent: random(40, 80),
            htGoalPercent: random(50, 85)
        };
    }

    /**
     * Generate mock match history
     */
    _generateMockMatches(teamName, count) {
        const matches = [];
        const opponents = ['Team A', 'Team B', 'Team C', 'Team D', 'Team E'];
        
        // Seed based on team name
        const seed = teamName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
        const seededRandom = (offset) => {
            const x = Math.sin(seed + offset) * 10000;
            return x - Math.floor(x);
        };

        for (let i = 0; i < count; i++) {
            const homeGoals = Math.floor(seededRandom(i * 10) * 4);
            const awayGoals = Math.floor(seededRandom(i * 20) * 4);
            const htHomeGoals = Math.floor(seededRandom(i * 30) * (homeGoals + 1));
            const htAwayGoals = Math.floor(seededRandom(i * 40) * (awayGoals + 1));

            matches.push({
                date: new Date(Date.now() - (i + 1) * 7 * 24 * 60 * 60 * 1000).toLocaleDateString('fr-FR'),
                opponent: opponents[i],
                score: `${homeGoals}-${awayGoals}`,
                htScore: `${htHomeGoals}-${htAwayGoals}`,
                totalGoals: homeGoals + awayGoals,
                btts: homeGoals > 0 && awayGoals > 0,
                htGoal: htHomeGoals > 0 || htAwayGoals > 0
            });
        }

        return matches;
    }

    /**
     * Clear cache (useful for refreshing data)
     */
    clearCache() {
        this.cache.clear();
    }

    /**
     * Get predictions for multiple matches
     */
    generateBulkPredictions(matches) {
        return matches.map(match => ({
            ...match,
            predictions: this.generatePredictions(match)
        }));
    }
}

const predictionService = new PredictionService();
export default predictionService;
