/**
 * 🧬 TITANIUM EVOLUTION LAYER - EVOLUTION ENGINE
 * ---------------------------------------------
 * This engine processes autopsy results to detect patterns of failure
 * and updates the global Intelligence Database.
 */

const db = require('../core/database');
const logger = require('../core/logger');

class EvolutionEngine {
    constructor() {
        this.TAXONOMY = [
            'PERSONNEL_DEFICIT_DISRUPTION',
            'EARLY_TACTICAL_DISRUPTION',
            'SET_PIECE_DECIDER',
            'SYSTEMIC_DEFENSIVE_FAILURE',
            'LOW_INTENSITY_OFFENSE',
            'XG_WASTE',
            'GK_WALL',
            'BIG_CHANCE_WASTE',
            'SHOT_DOMINANCE',
            'CORNER_DOMINANCE',
            'LATE_GOAL',
            'POSSESSION_FAIL',
            'RED_CARD_COLLAPSE',
            'GOALKEEPER_MASTERCLASS',
            'LATE_GOAL_VARIANCE',
            'PENALTY_ANOMALY',
            'LOW_XG_CONVERSION',
            'MOTIVATION_MISREAD',
            'ODDS_TRAP_PATTERN'
        ];
        this.init();
    }

    async init() {
        try {
            db.exec(`CREATE TABLE IF NOT EXISTS failure_intelligence (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                failure_type TEXT,
                league TEXT,
                team TEXT,
                referee_id TEXT,
                frequency INTEGER DEFAULT 0,
                avg_confidence REAL,
                impact_roi REAL DEFAULT 0,
                impact_clv REAL DEFAULT 0,
                last_detected TEXT,
                UNIQUE(failure_type, league, team)
            );`);
        } catch (e) {}
    }

    async processLatestAutopsies() {
        logger.info('🧬 [EVOLUTION] Aggregating failure intelligence patterns...');
        try {
            // Get all matches with autopsies that haven't been indexed into failure_intelligence yet
            // (For simplicity in this version, we aggregate everything periodically)
            const autopsies = await db.prepare(`
                SELECT id, league, homeTeam, awayTeam, referee_id, confidence, autopsy_result 
                FROM matches 
                WHERE is_autopsied = 1
            `).all();

            for (const row of autopsies) {
                const root = JSON.parse(row.autopsy_result);
                const autopsyData = root.autopsy || root;
                const failureType = autopsyData.type || 'UNKNOWN';
                
                if (!this.TAXONOMY.includes(failureType)) continue;

                // Update League Intelligence
                await this.updatePattern(failureType, row.league, 'GLOBAL', row.referee_id, row.confidence);
                
                // Update Team Intelligence (Home)
                await this.updatePattern(failureType, row.league, row.homeTeam, null, row.confidence);
                
                // Update Team Intelligence (Away)
                await this.updatePattern(failureType, row.league, row.awayTeam, null, row.confidence);
            }

            logger.info(`✅ [EVOLUTION] Intelligence Database updated with ${autopsies.length} cases.`);
        } catch (error) {
            logger.error(`❌ [EVOLUTION] Aggregation error: ${error.message}`);
        }
    }

    async updatePattern(type, league, team, refereeId, confidence) {
        try {
            // Check if exists
            const existing = await db.prepare(`
                SELECT id, frequency FROM failure_intelligence 
                WHERE failure_type = ? AND league = ? AND team = ?
            `).get(type, league, team);

            if (existing) {
                await db.prepare(`
                    UPDATE failure_intelligence 
                    SET frequency = frequency + 1,
                        avg_confidence = (avg_confidence + ?) / 2,
                        last_detected = ?
                    WHERE id = ?
                `).run(confidence, new Date().toISOString(), existing.id);
            } else {
                await db.prepare(`
                    INSERT INTO failure_intelligence (failure_type, league, team, referee_id, frequency, avg_confidence, last_detected)
                    VALUES (?, ?, ?, ?, 1, ?, ?)
                `).run(type, league, team, refereeId, confidence, new Date().toISOString());
            }
        } catch (e) {
            // Ignore unique constraint errors or DB locks
        }
    }

    /**
     * Returns a "Risk Multiplier" for a specific match context.
     * Used by the Confidence Calibration Engine.
     */
    async getMatchRiskFactor(league, home, away, refereeId) {
        try {
            const patterns = await db.prepare(`
                SELECT failure_type, frequency FROM failure_intelligence
                WHERE (league = ? AND team = 'GLOBAL')
                   OR (team = ?)
                   OR (team = ?)
                   OR (referee_id = ? AND referee_id IS NOT NULL)
            `).all(league, home, away, refereeId);

            let riskMultiplier = 1.0;
            for (const p of patterns) {
                // Chaotic leagues or teams increase risk
                if (p.frequency > 5) riskMultiplier += 0.05;
                if (p.frequency > 15) riskMultiplier += 0.10;
            }

            return Math.min(1.5, riskMultiplier);
        } catch (e) {
            return 1.0;
        }
    }
}

module.exports = new EvolutionEngine();
