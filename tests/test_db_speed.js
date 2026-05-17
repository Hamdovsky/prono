const database = require('./database');

async function test() {
    console.log('Starting DB query...');
    const start = Date.now();
    try {
        const matches = await database.getMatchesByStatus('scheduled');
        const end = Date.now();
        console.log(`Query took ${end - start}ms. Found ${matches.length} matches.`);
    } catch (e) {
        console.error('Query failed:', e.message);
    }
}

test();
