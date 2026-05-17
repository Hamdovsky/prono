const fs = require('fs');
const path = require('path');
const database = require('../core/database');
const logger = require('../core/logger');

const WEIGHTS_FILE = path.join(__dirname, '..', 'data', 'model_weights.json');
const CACHE_MAX_AGE = 5 * 60 * 1000; // 5 minutes

class PatternService {
    constructor() {
        this.patternMatchCache = new Map();
    }

    async logWinningPattern(match) {
        try {
            const scoreState = `${match.score.home}-${match.score.away}`;
            const timePeriod = (match.minute && match.minute.includes('2nd')) ? '2nd_half' : '1st_half';

            // Insert into SQLite pattern history
            await database.insertPattern(match);
            logger.info(`📈 [PATTERN] Logged: ${match.homeTeam} vs ${match.awayTeam} [${scoreState} @ ${timePeriod}]`);
        } catch (e) {
            logger.error(`❌ [PATTERN] Failed to log pattern: ${e.message}`);
        }
    }

    async applyVVIPBoost(match) {
        try {
            const patterns = await database.getAllPatterns(50);
            if (!Array.isArray(patterns) || patterns.length < 5) return match;

            let weights = { vvip_boost_multiplier: 1.12, pressure_baseline: 60 };
            if (fs.existsSync(WEIGHTS_FILE)) {
                try {
                    const data = JSON.parse(fs.readFileSync(WEIGHTS_FILE));
                    weights = data.coefficients || weights;
                } catch (e) { /* use default */ }
            }

            const currentScoreState = `${match.score.home}-${match.score.away}`;
            const currentTimePeriod = (match.minute && match.minute.includes('2nd')) ? '2nd_half' : '1st_half';
            const currentPressure = match.stats?.pressure?.home || 0;

            const cacheKey = `${match.league}_${currentScoreState}_${currentTimePeriod}_${currentPressure}_${match.winProb}`;
            if (this.patternMatchCache.has(cacheKey)) {
                const cached = this.patternMatchCache.get(cacheKey);
                if (Date.now() - cached.timestamp < CACHE_MAX_AGE) return cached.result;
            }

            // Multi-dimensional pattern matching logic
            const matchedPatterns = patterns.map(p => {
                const patternAge = (Date.now() - new Date(p.timestamp).getTime()) / (1000 * 60 * 60 * 24 * 7);
                const decayFactor = Math.max(0.7, 1 - (patternAge * 0.02)); 
                const leagueMatch = p.league === match.league ? 30 : 0;
                const scoreStateMatch = (p.score?.home === match.score.home && p.score?.away === match.score.away) ? 25 : 0;
                const pPressure = p.stats?.pressure?.home || 0;
                const pressureSimilarity = Math.abs(pPressure - currentPressure) < 15 ? 15 : 0;
                const probSimilarity = Math.abs((p.winProb || 50) - (match.winProb || 50)) < 10 ? 5 : 0;
                const totalScore = (leagueMatch + scoreStateMatch + pressureSimilarity + probSimilarity) * decayFactor;
                return { pattern: p, score: totalScore, decayFactor };
            }).filter(m => m.score >= 50);

            if (matchedPatterns.length >= 3) {
                const avgDecay = matchedPatterns.reduce((sum, m) => sum + m.decayFactor, 0) / matchedPatterns.length;
                const patternStrength = Math.min(matchedPatterns.length / 10, 1);
                const baseBoost = (match.winProb || 50) * (weights.vvip_boost_multiplier - 1);
                const boost = Math.round(baseBoost * avgDecay * (1 + patternStrength * 0.3));
                const finalBoost = Math.max(5, Math.min(15, boost));

                const boostedMatch = {
                    ...match,
                    winProb: Math.min(99, (match.winProb || 50) + finalBoost),
                    isVVIP: true,
                    vvipDetails: {
                        patternCount: matchedPatterns.length,
                        boostAmount: finalBoost,
                        confidenceDecay: avgDecay
                    }
                };

                this.patternMatchCache.set(cacheKey, { result: boostedMatch, timestamp: Date.now() });
                if (this.patternMatchCache.size > 100) this.patternMatchCache.delete(this.patternMatchCache.keys().next().value);
                return boostedMatch;
            }
        } catch (e) {
            logger.error(`❌ [PATTERN] VVIP Boost Error: ${e.message}`);
        }
        return match;
    }
}

module.exports = new PatternService();
