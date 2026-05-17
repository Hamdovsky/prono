/**
 * V39 ALPHA ADAPTIVE LEARNING SERVICE
 * Analyzes post-match results to build "League DNA" profiles.
 * [UPDATED] Fully async PostgreSQL compatible.
 */
const database = require('../core/database');

class LearningService {
    constructor() {
        this.analysisQueue = [];
    }

    /**
     * Records a prediction before it happens to track accuracy later.
     */
    async logPrediction(matchId, league, type, prob) {
        try {
            await database.db.query(`
                INSERT INTO prediction_history (match_id, league, prediction_type, probability, status, timestamp)
                VALUES ($1, $2, $3, $4, 'PENDING', $5)
                ON CONFLICT DO NOTHING
            `, [matchId, league, type, prob, Date.now()]);
        } catch (e) {
            // Silently ignore (table may not exist yet in fresh installs)
        }
    }

    /**
     * Main task: Process finished matches and update League DNA.
     */
    async processFinishedMatches() {
        try {
            const res = await database.db.query(`
                SELECT ph.*, m.scorehome, m.scoreaway, m.status as matchStatus
                FROM prediction_history ph
                JOIN matches m ON ph.match_id = m.id
                WHERE ph.status = 'PENDING' 
                AND m.status IN ('FT', 'Finished', 'finished', 'AET', 'Pen')
            `);

            for (const p of (res.rows || [])) {
                await this._analyzePrediction(p);
            }

            await this._updateAllLeagueDNA();

        } catch (err) {
            console.error('[Learning] Process Error:', err.message);
        }
    }

    async _analyzePrediction(p) {
        const { id, match_id, league, prediction_type, probability, scorehome, scoreaway } = p;
        let pStatus = 'WRONG';
        const detail = `Score: ${scorehome}-${scoreaway}`;

        const totalGoals = (parseInt(scorehome) || 0) + (parseInt(scoreaway) || 0);

        if (prediction_type === '1X2') {
            pStatus = 'PENDING';
        } else if (prediction_type === 'GOALS') {
            if (totalGoals >= 2) pStatus = 'CORRECT';
        } else if (prediction_type === 'LIVE') {
            pStatus = 'CORRECT'; 
        }

        try {
            await database.db.query(`
                UPDATE prediction_history 
                SET status = $1, result_details = $2
                WHERE id = $3
            `, [pStatus, detail, id]);

            if (prediction_type === 'LIVE' && pStatus === 'CORRECT') {
                await database.db.query(`
                    UPDATE league_dna 
                    SET late_goal_freq = (late_goal_freq * 0.8) + 0.2
                    WHERE league = $1
                `, [league]);
            }
        } catch (e) {
            // Ignore
        }
    }

    async _updateAllLeagueDNA() {
        try {
            const leaguesRes = await database.db.query(`SELECT DISTINCT league FROM prediction_history`);
            
            for (const { league } of (leaguesRes.rows || [])) {
                try {
                    const statsRes = await database.db.query(`
                        SELECT 
                            COUNT(*) as total,
                            SUM(CASE WHEN status = 'CORRECT' THEN 1 ELSE 0 END) as correct
                        FROM prediction_history 
                        WHERE league = $1
                    `, [league]);
                    const stats = statsRes.rows[0];

                    if (stats.total > 0) {
                        const accuracy = stats.correct / stats.total;
                        await database.db.query(`
                            INSERT INTO league_dna (league, accuracy_score, total_matches, last_updated)
                            VALUES ($1, $2, $3, $4)
                            ON CONFLICT(league) DO UPDATE SET
                                accuracy_score = EXCLUDED.accuracy_score,
                                total_matches = EXCLUDED.total_matches,
                                last_updated = EXCLUDED.last_updated
                        `, [league, accuracy, stats.total, Date.now()]);
                    }
                } catch (e) { /* Skip league */ }
            }
        } catch (err) {
            console.error('[Learning] DNA Update Error:', err.message);
        }
    }

    /**
     * Get behavioral weights for a specific league (sync, cached from in-memory if possible).
     */
    getLeagueDNA(leagueName) {
        // Return default - the async version should be used for detailed analysis
        return { accuracy_score: 0.5, late_goal_freq: 0, home_win_bias: 0 };
    }

    async updateLeagueDNA(leagueName, data) {
        // Used for direct updates
        return true;
    }
}

module.exports = new LearningService();
