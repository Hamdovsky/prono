/**
 * rebuild_accuracy.js
 * ─────────────────────────────────────────────────────────────
 * Re-runs the accuracy analysis for the last 30 days to fix 
 * zeros and missing data caused by previous logic errors.
 */

const { runAnalysis } = require('./today_analysis');
const logger = require('../core/logger');

async function rebuild() {
    logger.info('🛠️ [REBUILD] Starting historical accuracy reconstruction (30 days)...');
    
    const dates = [];
    for (let i = 0; i < 30; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().split('T')[0]);
    }

    // Process dates (oldest first for streak consistency)
    dates.reverse();

    let processedCount = 0;
    for (const date of dates) {
        process.stdout.write(`⏳ Analysing ${date}... `);
        try {
            await runAnalysis(date);
            console.log('✅');
            processedCount++;
        } catch (e) {
            console.log(`❌ (${e.message})`);
        }
    }

    logger.info(`🏁 [REBUILD] Finished. Processed ${processedCount} days.`);
}

if (require.main === module) {
    rebuild().then(() => process.exit(0)).catch(e => {
        console.error('Rebuild failed:', e);
        process.exit(1);
    });
}
