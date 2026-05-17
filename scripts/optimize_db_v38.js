const database = require('../core/database');
const logger = require('../core/logger');

async function optimize() {
    logger.info('🚀 [DB_OPTIMIZER] Starting advanced indexing...');
    try {
        const queries = [
            'CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status)',
            'CREATE INDEX IF NOT EXISTS idx_matches_timestamp ON matches(timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_matches_league ON matches(league)',
            'CREATE INDEX IF NOT EXISTS idx_matches_home_team ON matches(hometeam)',
            'CREATE INDEX IF NOT EXISTS idx_matches_away_team ON matches(awayteam)',
            'CREATE INDEX IF NOT EXISTS idx_matches_last_updated ON matches(last_updated)'
        ];

        for (const sql of queries) {
            try {
                await database.exec(sql);
                logger.info(`✅ Executed: ${sql.slice(0, 30)}...`);
            } catch (err) {
                logger.warn(`⚠️  Failed to execute index (${sql.slice(25, 45)}): ${err.message}`);
            }
        }
        logger.info('🏁 [DB_OPTIMIZER] All indexing tasks completed.');
    } catch (e) {
        logger.error('❌ [DB_OPTIMIZER] Fatal error during optimization:', e.message);
    } finally {
        process.exit(0);
    }
}

optimize();
