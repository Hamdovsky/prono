const { runCloudSeed } = require('./core/cloudSeed');

async function testSeed() {
    console.log('Starting local cloud seed test...');
    try {
        await runCloudSeed();
        console.log('Seed test finished.');
        
        // Count matches in DB now
        const db = require('./core/database');
        const count = db.db.prepare(\`SELECT COUNT(*) as cnt FROM matches\`).get();
        console.log('Total matches in DB after seed:', count.cnt);
    } catch (e) {
        console.error('Error during seed:', e.message);
    }
}
testSeed();
