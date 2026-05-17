/**
 * universal_predictor.js — Titanium Omniscience Bulk Engine
 * ─────────────────────────────────────────────────────────────
 * Analyzes EVERY match in the database to ensure 100% coverage.
 * Applies deep AI to Elite matches and fast-track AI to others.
 */

const database = require('../core/database');
const enrichedPredictions = require('../core/enriched_predictions');
const logger = require('../core/logger');

async function runUniversalPrediction() {
    logger.info('🚀 [TITANIUM] Starting Universal Prediction Cycle (Omniscience Ω4.0)...');

    try {
        // 1. Fetch all matches needing analysis (Scheduled for the next 48h)
        const now = Math.floor(Date.now() / 1000);
        const end = now + (48 * 60 * 60);
        
        const matches = await database.prepare(`
            SELECT * FROM matches 
            WHERE status IN ('scheduled', 'NS', 'NOT_STARTED')
            AND (startTimestamp >= ? AND startTimestamp <= ?)
            ORDER BY startTimestamp ASC
        `).all(now - 3600, end);

        if (matches.length === 0) {
            logger.info('✅ No upcoming matches found to analyze.');
            return;
        }

        logger.info(`🔍 [TITANIUM] Found ${matches.length} matches in the 48h buffer.`);

        let count = 0;
        for (const match of matches) {
            try {
                count++;
                process.stdout.write(`\r🧠 Analyzing [${count}/${matches.length}] ${match.homeTeam} vs ${match.awayTeam}...`);

                // Perform Enrichment
                // Note: enrichMatch already handles Odds retrieval via the new upgraded service.
                const enriched = await enrichedPredictions.enrichMatch(match);
                
                if (enriched) {
                    await database.updatePredictions(match.id, enriched);
                }

                // Small delay to prevent API rate limiting (even with our bottleneck)
                if (count % 20 === 0) {
                    await new Promise(r => setTimeout(r, 1000));
                }

            } catch (err) {
                logger.error(`\n❌ Failed to analyze match ${match.id}: ${err.message}`);
            }
        }

        console.log(`\n\n✅ [TITANIUM] Universal Analysis Complete: ${count} matches processed.`);

    } catch (e) {
        logger.error(`💥 [CRITICAL] Universal Predictor Error: ${e.message}`);
    }
}

if (require.main === module) {
    runUniversalPrediction().then(() => process.exit(0)).catch(e => {
        console.error(e);
        process.exit(1);
    });
}

module.exports = { runUniversalPrediction };
