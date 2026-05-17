/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║     TITANIUM ADAPTIVE LEARNING AGENT (SYNC)                      ║
 * ║     Standalone runner for processing finished matches             ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const adaptiveLearning = require('../services/adaptiveLearningEngine');
const logger = console;

const DB_PATH = path.join(__dirname, '..', 'data', 'tactical.db');

async function syncLearning() {
    logger.info('🧠 [TITANIUM-LEARN] Starting sync agent...');

    try {
        const db = new Database(DB_PATH);
        
        // 1. Find matches that are finished but not in learning_memory
        const query = `
            SELECT * FROM matches 
            WHERE UPPER(status) IN ('FINISHED', 'FT', 'AET', 'PEN', 'TERMINÉ')
              AND id NOT IN (SELECT match_id FROM learning_memory)
            ORDER BY timestamp DESC
            LIMIT 1000
        `;
        
        const candidateMatches = db.prepare(query).all();
        
        if (candidateMatches.length === 0) {
            logger.info('✅ [TITANIUM-LEARN] No new finished matches to learn today.');
            return;
        }
        
        logger.info(`📈 [TITANIUM-LEARN] Found ${candidateMatches.length} unindexed matches. Ingesting...`);
        
        const batch = candidateMatches.map(m => {
            // Determine actual result from score
            let actualStr = 'D';
            if (m.scoreHome > m.scoreAway) actualStr = 'H';
            else if (m.scoreAway > m.scoreHome) actualStr = 'A';

            return {
                matchId: m.id,
                league: m.league,
                homeTeam: m.homeTeam,
                awayTeam: m.awayTeam,
                prediction: m.prediction,
                confidence: m.confidence || 65,
                actualResult: actualStr,
                scoreHome: m.scoreHome || 0,
                scoreAway: m.scoreAway || 0,
                matchDate: m.timestamp,
                matchStats: {
                    xg_home: m.xg_home || 0,
                    xg_away: m.xg_away || 0,
                    red_cards_home: m.red_cards_home || 0,
                    red_cards_away: m.red_cards_away || 0,
                    possession_home: m.possession_home || 50,
                    shots_on_target_home: m.shots_on_target_home || 3,
                    shots_on_target_away: m.shots_on_target_away || 3
                }
            };
        });
        
        const report = await adaptiveLearning.processBatch(batch);
        
        if (report.success) {
            logger.info(`🎉 [TITANIUM-LEARN] Batch complete! Correct: ${report.correctCount}/${report.totalProcessed}`);
        } else {
            logger.error(`❌ [TITANIUM-LEARN] Batch failed: ${report.error}`);
        }
        
        db.close();
        
    } catch (err) {
        logger.error(`💥 [TITANIUM-LEARN] Sync crash: ${err.message}`);
    }
}

if (require.main === module) {
    syncLearning();
}

module.exports = { syncLearning };
