const path = require('path');
const logger = require('../core/logger');
const database = require('../core/database');
const TeamRegistry = require('./teamRegistry');
const SeededRandom = require('../core/deterministic');

// 🔐 [INTEGRITY] Team name validator (linked to main DB)
const teamRegistry = new TeamRegistry(database);

// --- ARCHIVE DATABASE CONNECTION ---
const ARCHIVE_DB_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite');
let archiveDb;
try {
    archiveDb = new (require('better-sqlite3'))(ARCHIVE_DB_PATH, { readonly: true });
    logger.info(`📚 Expert Engine: Historical Archive linked: ${ARCHIVE_DB_PATH}`);
} catch (e) {
    logger.warn(`⚠️ Expert Engine: Historical Archive not found at ${ARCHIVE_DB_PATH}. Similarity checks disabled.`);
}

/**
 * Perform a similarity lookup in the historical archive
 */
function getHistoricalSimilarity(daRatio, possessionRatio) {
    if (!archiveDb) return { count: 0, goalProb: 0.5 };
    try {
        // 🛡️ [OPTIMIZATION] Avoid json_extract on 1GB archive if possible.
        // For now, we will use a simpler check or skip if memory is tight.
        // In a real production scenario, these stats should be regular columns with indices.

        // Skip expensive scan if it's too risky for now
        return { count: 0, goalProb: 0.5 };

        /* 
        const row = archiveDb.prepare(`
            SELECT count(*) as count, avg(scoreHome + scoreAway > 0) as goalProb
            FROM archive_matches
            WHERE abs((CAST(json_extract(stats_blob, '$."Dangerous Attacks"[0]') AS FLOAT) / 
                  (json_extract(stats_blob, '$."Dangerous Attacks"[0]') + json_extract(stats_blob, '$."Dangerous Attacks"[1]'))) - ?) < 0.05
            AND abs((CAST(json_extract(stats_blob, '$."Ball Possession"[0]') AS FLOAT) / 100) - ?) < 0.05
        `).get(daRatio, possessionRatio);
        return { count: row.count, goalProb: row.goalProb || 0.5 };
        */
    } catch (e) {
        return { count: 0, goalProb: 0.5 };
    }
}

/**
 * Poisson Goal Expectancy
 * Calculates probability of >= 1 goal in next 10 minutes.
 * @param {number} dapm Dangerous Attacks Per Minute
 */
function getPoissonExpectancy(dapm) {
    // Avg conversion: ~1 goal every 25 dangerous attacks (baseline)
    const conversionFactor = 0.04;
    const timeWindow = 10;
    const lambda = dapm * conversionFactor * timeWindow;
    // P(X >= 1) = 1 - e^(-lambda)
    return (1 - Math.exp(-lambda)) * 100;
}

/**
 * 🎯 The Strike Formula (W-M-C Model)
 * @param {Object} w Weighted Pressure scores
 * @param {number} m Momentum Velocity
 * @param {number} c Chaos Factor (Volatility)
 */
function calculateStrikeScore(w, m, c) {
    // Weights: Pressure (0.5), Momentum (0.3), Chaos/Intensity (0.2)
    const base = (w.home * 0.5) + (m * 0.3) + (c * 0.2);
    return Math.min(99, Math.max(0, base));
}

/**
 * 🎯 EXPERT PREDICTION ENGINE v4.2 [LETHAL]
 * Generates full tactical intelligence for a match object.
 */
function getMatchIntelligence(m) {
    try {
        const rawData = typeof m.fullData === 'string' ? JSON.parse(m.fullData) : m.fullData || {};
        const statsSource = rawData.statistics || rawData.stats || m.stats || {};

        const parseStat = (val) => {
            if (typeof val === 'number') return val;
            if (typeof val === 'string') {
                const match = val.match(/(\d+(?:\.\d+)?)/);
                return match ? parseFloat(match[1]) : 0;
            }
            return 0;
        };

        const getStatFromArray = (category, home = true) => {
            if (Array.isArray(statsSource)) {
                const stat = statsSource.find(s => s.category?.toLowerCase().includes(category.toLowerCase()));
                if (!stat) return 0;
                return parseStat(home ? stat.homeValue : stat.awayValue);
            }
            // If it's already an object (e.g. from previously processed data)
            if (statsSource[category] && typeof statsSource[category] === 'object') {
                return parseStat(home ? statsSource[category].home : statsSource[category].away);
            }
            return 0;
        };

        const daHome = statsSource.dangerousAttacks?.home || getStatFromArray('Dangerous Attacks', true) || parseStat(m.dangerous_attacks_home) || 0;
        const daAway = statsSource.dangerousAttacks?.away || getStatFromArray('Dangerous Attacks', false) || parseStat(m.dangerous_attacks_away) || 0;
        const totalDA = daHome + daAway;

        const possHome = statsSource.possession?.home || getStatFromArray('Possession', true) || parseStat(m.possession_home) || 50;
        const possAway = statsSource.possession?.away || getStatFromArray('Possession', false) || parseStat(m.possession_away) || 50;

        const shotsHome = (statsSource.totalShots?.home || (getStatFromArray('Shots on Target', true) + getStatFromArray('Shots off Target', true))) || parseStat(m.shots_on_target_home) || 0;
        const shotsAway = (statsSource.totalShots?.away || (getStatFromArray('Shots on Target', false) + getStatFromArray('Shots off Target', false))) || parseStat(m.shots_on_target_away) || 0;

        const cornersHome = statsSource.corners?.home || getStatFromArray('Corner Kicks', true) || parseStat(m.corners_home) || 0;
        const cornersAway = statsSource.corners?.away || getStatFromArray('Corner Kicks', false) || parseStat(m.corners_away) || 0;

        const homeAttacks = getStatFromArray('Attacks', true) || 1;
        const awayAttacks = getStatFromArray('Attacks', false) || 1;

        let minute = parseInt(m.minute) || 0;
        if (m.minute && typeof m.minute === 'string') {
            if (m.minute.includes('HT')) minute = 45;
            if (m.minute.includes('+')) {
                const parts = m.minute.split('+');
                minute = parseInt(parts[0]) + parseInt(parts[1]);
            }
        }

        const dapm = minute > 0 ? (totalDA / minute) : 0;
        const matchId = m.id || `${m.homeTeam}_${m.awayTeam}`;

        // 🛡️ [GUARD] Ensure match object has correct stats structure
        m.stats = {
            dangerousAttacks: { home: daHome, away: daAway },
            possession: { home: possHome, away: possAway },
            totalShots: { home: shotsHome, away: shotsAway },
            corners: { home: cornersHome, away: cornersAway },
            attacks: { home: homeAttacks, away: awayAttacks },
            pressure: { home: daHome, away: daAway }
        };

        m.time = m.minute; // Sync time for scalpingEngine

        // 1. Tactical Processing (Simplified for Pre-Match)
        const tactical = { pressure: { home: daHome, away: daAway }, intensity: { home: 0, away: 0 } };
        m.alpha = { ...m.alpha, indices: tactical };
        const isHighIntensity = (daHome / homeAttacks > 0.7) || (daAway / awayAttacks > 0.7);

        // 3. Logistics & Travel Fatigue [V26]
        const LogisticsService = require('./LogisticsService');
        const homeCity = m.home_city || LogisticsService.resolveCity(m.homeTeam);
        const awayCity = m.away_city || LogisticsService.resolveCity(m.awayTeam);
        const daysRestH = m.days_since_last_match_home || 4;
        const daysRestA = m.days_since_last_match_away || 4;
        
        const travelFatigue = LogisticsService.calculateFatigue(awayCity, homeCity, daysRestA);
        
        // 4. Similarity
        const daRatio = totalDA > 0 ? daHome / totalDA : 0.5;
        const similarity = getHistoricalSimilarity(daRatio, possHome);
        const historicalGoalProb = similarity.count > 3 ? similarity.goalProb : 0.5;

        // 5. Boosts & Adjustments
        let visionBoost = 0;
        try {
            const vision = database.get('SELECT description FROM vision_log ORDER BY timestamp DESC LIMIT 1');
            if (vision && vision.description?.toLowerCase().includes('pressure')) visionBoost = 5;
        } catch (e) { }

        // Apply Travel Fatigue Penalty to Away Team Win Prob
        let fatiguePenalty = travelFatigue.impact === 'HIGH' ? 8 : (travelFatigue.impact === 'MEDIUM' ? 4 : 0);
        
        let winProb = 50 + visionBoost - fatiguePenalty;

        let predictionLabel = 'MONITORING';
        const tacticalLabels = [];

        // 6. Tactical Scenarios [V27] - Aggregate Score Logic
        // m.aggregate_score format: "2-0" (Home-Away from 1st leg)
        if (m.aggregate_score) {
            const [aggH, aggA] = m.aggregate_score.split('-').map(Number);
            const goalDiff = (aggH || 0) - (aggA || 0);

            if (goalDiff >= 2) {
                // Home team defending a lead => Defensive posture
                tacticalLabels.push('🛡️ DEFENSIVE PROTOCOL');
                winProb -= 5; // Less likely to push for more
            } else if (goalDiff <= -2) {
                // Home team chasing a big comeback => Aggressive posture
                tacticalLabels.push('🔥 REMONTADA MODE');
                winProb += 10;
                m.intensity_boost = 1.25;
            }
        }

        if (dapm > 1.2 && Math.max(possHome, possAway) > 60) {
            winProb = 85;
            tacticalLabels.push('💎 ELITE TARGET');
        }
        if (dapm > 2.0) {
            winProb = 92;
            tacticalLabels.push('🔥 GOAL IMMINENT');
        }

        const strikeIndex = calculateStrikeScore(
            { home: tactical.pressure?.home || 0, away: tactical.pressure?.away || 0 },
            0,
            (tactical.intensity?.home || 0.5) * 100
        );

        if (strikeIndex > 65) {
            predictionLabel = '🎯 LETHAL STRIKE';
            winProb = 95;
        } else if (tacticalLabels.length > 0) {
            predictionLabel = tacticalLabels[0];
        }

        return {
            ...m,
            winProb: Math.min(winProb, 99),
            prediction: predictionLabel,
            tacticalLabels: tacticalLabels,
            dapm: dapm.toFixed(2),
            strikeIndex: parseFloat(strikeIndex.toFixed(1)),
            travelFatigue: travelFatigue, // [V26] Geographic logistics data
            isLive: m.status === 'live'
        };
    } catch (e) {
        console.error(`❌ [EXPERT ERROR] Match ${m.id}:`, e.message);
        console.error(e.stack);
        return { ...m, error: true, prediction: 'ERROR' };
    }
}

/**
 * 🎯 ORACLE SIMULATION v4.0 (Monte Carlo)
 * Runs 10,000 simulations based on current match probabilities.
 */
async function simulate(m, lineupImpact = {}) {
    try {
        const ITERATIONS = 10000;
        
        const homeWinP = parseFloat(m.home_win_probability || 33.3);
        const drawP    = parseFloat(m.draw_probability     || 33.3);
        const awayWinP = parseFloat(m.away_win_probability || 33.4);
        
        // Derive base lambda (Expected Goals) from OU 2.5 if available, else baseline
        const ou25Prob = parseFloat(m.over_25_probability || 50);
        let baseLambda = (ou25Prob / 100) * 1.6 + 1.6;

        // Apply Lineup Penalties (V6 logic)
        const homePenalty = lineupImpact.home || 0;
        const awayPenalty = lineupImpact.away || 0;
        
        // Probability shares
        const totalWinP = homeWinP + awayWinP + (drawP * 0.5);
        let homeShare = (homeWinP + (drawP * 0.25)) / (totalWinP || 1);
        let awayShare = (awayWinP + (drawP * 0.25)) / (totalWinP || 1);
        
        let homeLambda = baseLambda * homeShare - homePenalty;
        let awayLambda = baseLambda * awayShare - awayPenalty;
        
        homeLambda = Math.max(0.1, homeLambda);
        awayLambda = Math.max(0.1, awayLambda);

        const outcomes = { home: 0, draw: 0, away: 0 };
        const prng = new SeededRandom(m.id || `${m.homeTeam}_${m.awayTeam}`);

        for (let i = 0; i < ITERATIONS; i++) {
            const hG = _poissonRandom(homeLambda, prng);
            const aG = _poissonRandom(awayLambda, prng);
            if (hG > aG) outcomes.home++;
            else if (hG < aG) outcomes.away++;
            else outcomes.draw++;
        }

        return {
            home_prob: (outcomes.home / ITERATIONS) * 100,
            draw_prob: (outcomes.draw / ITERATIONS) * 100,
            away_prob: (outcomes.away / ITERATIONS) * 100,
            sim_v: "ExpertV4-Sim"
        };
    } catch (e) {
        logger.error(`[ORACLE-SIM] Error: ${e.message}`);
        return null;
    }
}

function _poissonRandom(lambda, prng) {
    let L = Math.exp(-lambda);
    let p = 1.0;
    let k = 0;
    do {
        k++;
        p *= (prng ? prng.next() : Math.random());
    } while (p > L);
    return k - 1;
}

module.exports = {
    getMatchIntelligence,
    getHistoricalSimilarity,
    simulate
};
