const database = require('./database');

async function test() {
    try {
        const matches = await database.getMatchesByStatus('scheduled'); // and we'll check others too if needed
        const Database = require('better-sqlite3');
        const db = new Database('./data/tactical.db');
        const all = db.prepare("SELECT status, startTimestamp FROM matches").all();
        
        const now = new Date();
        const todayStr = now.toDateString();
        
        const todayMatches = all.filter(m => new Date(m.startTimestamp * 1000).toDateString() === todayStr);
        console.log(`Matches for ${todayStr}: ${todayMatches.length}`);
        
        const stats = {};
        todayMatches.forEach(m => {
            stats[m.status] = (stats[m.status] || 0) + 1;
        });
        console.log('Status break-down for Today:', stats);

        if (todayMatches.length === 0 && all.length > 0) {
            console.log('First 5 matches in DB dates:');
            all.slice(0, 5).forEach(m => {
                console.log(`- ${m.status}: ${new Date(m.startTimestamp * 1000).toDateString()}`);
            });
        }
    } catch (e) {
        console.error(e);
    }
}

test();
