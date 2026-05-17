const database = require('../core/database');
const patternService = require('./patternService');
const logger = require('../core/logger');

class LiveGoalPredictor {
    constructor() {
        this.goalMatrix = this.initializeGoalMatrix();
        this.patternWeights = this.loadPatternWeights();
        this.activeMatches = new Map();
    }

    initializeGoalMatrix() {
        return {
            scorePatterns: {
                "0-0": { firstHalf: 72, secondHalf: 88, after60: 94 },
                "1-0": { firstHalf: 65, secondHalf: 78, after60: 85 },
                "0-1": { firstHalf: 63, secondHalf: 76, after60: 83 },
                "1-1": { firstHalf: 78, secondHalf: 89, after60: 96 },
                "2-0": { firstHalf: 52, secondHalf: 68, after60: 75 },
                "0-2": { firstHalf: 50, secondHalf: 66, after60: 73 },
                "2-1": { firstHalf: 82, secondHalf: 91, after60: 97 },
                "1-2": { firstHalf: 80, secondHalf: 90, after60: 96 },
                "2-2": { firstHalf: 88, secondHalf: 95, after60: 98 },
                "3-0": { firstHalf: 42, secondHalf: 58, after60: 65 },
                "3-1": { firstHalf: 74, secondHalf: 85, after60: 92 },
                "3-2": { firstHalf: 92, secondHalf: 97, after60: 99 }
            },
            
            minuteThresholds: {
                earlyGoal: { under15: 85, under25: 78, under35: 72 },
                latePressure: { after65: 88, after75: 93, after80: 96, after85: 98 },
                drySpell: { noGoal30min: 76, noGoal40min: 84, noGoal50min: 92 }
            },

            dangerZones: {
                cornersInLast5: { 0: 10, 1: 25, 2: 45, 3: 65, '4+': 85 },
                attacksLast10: { '<5': 15, '5-10': 40, '10-15': 65, '15+': 88 },
                xgLast15: { '<0.3': 20, '0.3-0.7': 50, '0.7-1.2': 75, '>1.2': 90 }
            },

            historicalMatrix: {
                leagueMultipliers: {
                    "Premier League": 1.12,
                    "Bundesliga": 1.18,
                    "Serie A": 1.05,
                    "La Liga": 1.08,
                    "Ligue 1": 1.10,
                    "Champions League": 1.15,
                    "Europa League": 1.13,
                    "default": 1.0
                }
            }
        };
    }

    loadPatternWeights() {
        return {
            scoreState: 0.35,
            timeElapsed: 0.20,
            attackPressure: 0.18,
            oddsMovement: 0.12,
            historicalPattern: 0.10,
            redCardFactor: 0.05
        };
    }

    async analyzeLiveMatch(match) {
        if (!match || !match.isLive) return null;

        const analysis = {
            matchId: match.id,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            minute: match.minute || 0,
            score: match.score || { home: 0, away: 0 },
            timestamp: Date.now(),
            factors: {},
            probabilities: {},
            prediction: null,
            confidence: 0,
            alertLevel: 'NORMAL'
        };

        analysis.factors.scoreState = this.calculateScoreStateFactor(match);
        analysis.factors.timeFactor = this.calculateTimeFactor(match);
        analysis.factors.pressureFactor = this.calculatePressureFactor(match);
        analysis.factors.oddsFactor = this.calculateOddsMovementFactor(match);
        analysis.factors.patternMatch = await this.calculatePatternMatchFactor(match);
        analysis.factors.redCardFactor = this.calculateRedCardFactor(match);

        let totalProbability = 0;
        Object.entries(analysis.factors).forEach(([factor, value]) => {
            totalProbability += value * this.patternWeights[factor];
        });

        const leagueMultiplier = this.goalMatrix.historicalMatrix.leagueMultipliers[match.league] || 1.0;
        totalProbability = Math.min(99, totalProbability * leagueMultiplier);

        analysis.probabilities = {
            next5min: Math.min(99, totalProbability * 0.3),
            next10min: Math.min(99, totalProbability * 0.55),
            next15min: Math.min(99, totalProbability * 0.75),
            restOfMatch: Math.round(totalProbability)
        };

        analysis.confidence = this.calculateConfidenceLevel(analysis);
        analysis.prediction = this.generatePrediction(analysis, match);
        
        if (analysis.probabilities.next10min > 75) analysis.alertLevel = 'HIGH';
        if (analysis.probabilities.next10min > 85) analysis.alertLevel = 'CRITICAL';
        if (analysis.probabilities.next10min > 92) analysis.alertLevel = 'IMMINENT';

        analysis.patternMatched = await this.findMatchingPatterns(match);
        
        this.activeMatches.set(match.id, analysis);
        return analysis;
    }

    calculateScoreStateFactor(match) {
        const scoreKey = `${match.score?.home || 0}-${match.score?.away || 0}`;
        const pattern = this.goalMatrix.scorePatterns[scoreKey] || this.goalMatrix.scorePatterns["0-0"];
        
        const minute = parseInt(match.minute) || 0;
        if (minute < 45) return pattern.firstHalf;
        if (minute < 60) return pattern.secondHalf;
        return pattern.after60;
    }

    calculateTimeFactor(match) {
        const minute = parseInt(match.minute) || 0;
        const goals = (match.score?.home || 0) + (match.score?.away || 0);
        
        let factor = 50;
        
        if (minute > 75) factor += 35;
        else if (minute > 65) factor += 25;
        else if (minute > 55) factor += 15;
        
        const lastGoalMinute = match.lastGoalMinute || 0;
        const minutesSinceGoal = minute - lastGoalMinute;
        
        if (minutesSinceGoal > 50) factor += 35;
        else if (minutesSinceGoal > 40) factor += 28;
        else if (minutesSinceGoal > 30) factor += 20;
        else if (minutesSinceGoal > 20) factor += 12;

        if (minute < 25 && goals === 0) factor += 20;
        
        return Math.min(95, factor);
    }

    calculatePressureFactor(match) {
        let factor = 50;
        const stats = match.stats || {};
        
        const corners = (stats.corners?.home || 0) + (stats.corners?.away || 0);
        if (corners >= 8) factor += 20;
        else if (corners >= 5) factor += 12;
        else if (corners >= 3) factor += 5;

        const attacks = (stats.dangerousAttacks?.home || 0) + (stats.dangerousAttacks?.away || 0);
        if (attacks > 40) factor += 25;
        else if (attacks > 30) factor += 18;
        else if (attacks > 20) factor += 10;

        const xgTotal = (stats.expectedGoals?.home || 0) + (stats.expectedGoals?.away || 0);
        if (xgTotal > 2.5) factor += 28;
        else if (xgTotal > 1.8) factor += 20;
        else if (xgTotal > 1.2) factor += 12;

        const shotsOnTarget = (stats.shotsOnTarget?.home || 0) + (stats.shotsOnTarget?.away || 0);
        if (shotsOnTarget > 8) factor += 22;
        else if (shotsOnTarget > 5) factor += 15;
        else if (shotsOnTarget > 3) factor += 8;

        return Math.min(95, factor);
    }

    calculateOddsMovementFactor(match) {
        let factor = 50;
        const odds = match.odds || {};
        
        if (odds.over25 && odds.over25 < 1.40) factor += 30;
        else if (odds.over25 && odds.over25 < 1.60) factor += 22;
        else if (odds.over25 && odds.over25 < 1.80) factor += 15;
        else if (odds.over25 && odds.over25 < 2.00) factor += 8;

        if (match.oddsMovement?.over25 > 0.15) factor -= 15;
        if (match.oddsMovement?.over25 < -0.15) factor += 18;

        return Math.min(95, Math.max(10, factor));
    }

    async calculatePatternMatchFactor(match) {
        const patterns = await database.getLivePatterns(match.league, 100);
        if (!patterns || patterns.length < 10) return 50;

        const currentState = {
            score: `${match.score?.home || 0}-${match.score?.away || 0}`,
            minute: parseInt(match.minute) || 0,
            totalGoals: (match.score?.home || 0) + (match.score?.away || 0)
        };

        const matches = patterns.filter(p => {
            const pGoals = (p.score?.home || 0) + (p.score?.away || 0);
            return p.scoreState === currentState.score && 
                   Math.abs(p.minute - currentState.minute) < 15 &&
                   pGoals === currentState.totalGoals;
        });

        if (matches.length === 0) return 50;

        const goalRate = matches.filter(m => m.hadGoalInNext15).length / matches.length;
        return Math.round(goalRate * 100);
    }

    calculateRedCardFactor(match) {
        if (!match.redCards) return 50;
        const totalRed = (match.redCards.home || 0) + (match.redCards.away || 0);
        if (totalRed === 0) return 50;
        if (totalRed === 1) return 75;
        return 85;
    }

    calculateConfidenceLevel(analysis) {
        const values = Object.values(analysis.factors);
        const variance = Math.max(...values) - Math.min(...values);
        
        if (variance < 20) return 95;
        if (variance < 30) return 85;
        if (variance < 40) return 70;
        return 55;
    }

    generatePrediction(analysis, match) {
        const prob = analysis.probabilities.restOfMatch;
        const minute = parseInt(match.minute) || 0;
        
        let prediction = {
            type: 'GOAL_EXPECTED',
            timing: 'unknown',
            side: 'either',
            recommendation: null
        };

        if (analysis.probabilities.next5min > 70) {
            prediction.timing = 'imminent';
            prediction.recommendation = '✅ BUT IMMINENT - Placer OVER maintenant';
        } else if (analysis.probabilities.next10min > 75) {
            prediction.timing = 'very_soon';
            prediction.recommendation = '⚡ BUT TRÈS PROBABLE dans les 10 prochaines minutes';
        } else if (analysis.probabilities.next15min > 70) {
            prediction.timing = 'soon';
            prediction.recommendation = '🔥 BUT ATTENDU dans les 15 prochaines minutes';
        } else if (prob > 80) {
            prediction.timing = 'likely';
            prediction.recommendation = '📈 Forte probabilité de but avant fin du match';
        } else if (prob < 30) {
            prediction.timing = 'unlikely';
            prediction.recommendation = '⚠️ Faible probabilité - Attention au piège';
        }

        if (match.stats?.expectedGoals?.home > match.stats?.expectedGoals?.away * 1.5) {
            prediction.side = 'home';
        } else if (match.stats?.expectedGoals?.away > match.stats?.expectedGoals?.home * 1.5) {
            prediction.side = 'away';
        }

        return prediction;
    }

    async findMatchingPatterns(match) {
        const patterns = await database.getRecentPatterns(50);
        const currentState = `${match.score?.home || 0}-${match.score?.away || 0}`;
        
        return patterns
            .filter(p => p.scoreState === currentState && Math.abs(p.minute - (parseInt(match.minute) || 0)) < 10)
            .slice(0, 5)
            .map(p => ({
                minute: p.minute,
                league: p.league,
                goalInNext: p.goalInNextMinutes,
                successRate: p.successRate
            }));
    }

    checkForGoalAlert(matchId) {
        const analysis = this.activeMatches.get(matchId);
        if (!analysis) return null;

        if (analysis.alertLevel === 'IMMINENT' || analysis.alertLevel === 'CRITICAL') {
            return {
                type: 'GOAL_ALERT',
                level: analysis.alertLevel,
                match: analysis,
                message: analysis.prediction.recommendation,
                confidence: analysis.confidence
            };
        }
        return null;
    }

    getActiveMatches() {
        return Array.from(this.activeMatches.values())
            .sort((a, b) => b.probabilities.next10min - a.probabilities.next10min);
    }
}

module.exports = new LiveGoalPredictor();
