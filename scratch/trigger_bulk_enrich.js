const cronManager = require('../services/cronManager');
const logger = require('../core/logger');

async function trigger() {
    console.log('🚀 [MANUAL] Starting bulk XGBoost enrichment to reach 50+ matches...');
    try {
        await cronManager.runProactiveEnrichment();
        console.log('✅ [MANUAL] Bulk enrichment complete.');
        process.exit(0);
    } catch (err) {
        console.error('❌ [MANUAL] Enrichment failed:', err);
        process.exit(1);
    }
}

trigger();
