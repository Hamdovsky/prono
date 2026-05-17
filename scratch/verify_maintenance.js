const database = require('./core/database');
const logger = require('./core/logger');

(async () => {
    console.log('--- DB MAINTENANCE VERIFICATION ---');
    try {
        const result = await database.maintenance();
        if (result) {
            console.log('✅ Maintenance executed successfully.');
        } else {
            console.log('❌ Maintenance failed (check logs).');
        }
    } catch (err) {
        console.error('💥 Crash during verification:', err.message);
    }
    process.exit(0);
})();
