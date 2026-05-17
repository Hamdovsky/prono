const database = require('../core/database');
const logger = require('../core/logger');

(async () => {
    try {
        console.log('Checking matches table...');
        const count = database.db.prepare('SELECT COUNT(*) as count FROM matches').get();
        console.log('Total matches:', count.count);
        
        const sample = database.db.prepare('SELECT * FROM matches LIMIT 1').get();
        console.log('Sample match:', JSON.stringify(sample, null, 2).substring(0, 500));
        
        const upcoming = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']);
        console.log('Upcoming count:', upcoming.length);
        
    } catch (e) {
        console.error('DB Check failed:', e);
    }
})();
