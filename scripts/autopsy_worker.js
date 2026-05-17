/**
 * 🔬 TITANIUM AI - AUTOPSY WORKER
 * ------------------------------
 * Automatically analyzes recently finished matches to detect
 * the root causes of prediction failures.
 */

const autopsyService = require('../services/autopsyService');
const evolutionEngine = require('../services/EvolutionEngine');
const logger = require('../core/logger');

async function runAutopsyCycle() {
    logger.info('🔬 [WORKER] Starting automated autopsy cycle...');
    try {
        const result = await autopsyService.generateAutopsyReport();
        if (result.status === 'success') {
            logger.info(`✅ [WORKER] Autopsy cycle complete. Analyzed: ${result.analyzedCount}, Failed: ${result.failedCount}`);
            
            // 🧬 TRIGGER EVOLUTION LAYER
            await evolutionEngine.processLatestAutopsies();
        } else {
            logger.error(`❌ [WORKER] Autopsy cycle failed: ${result.message}`);
        }
    } catch (error) {
        logger.error(`💥 [WORKER] Fatal error in autopsy cycle: ${error.message}`);
    }
}

// Run every 2 hours
setInterval(runAutopsyCycle, 2 * 60 * 60 * 1000);

// Run immediately on start
runAutopsyCycle();
