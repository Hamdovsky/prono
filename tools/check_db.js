const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'tactical.db');
const db = new Database(DB_PATH);

try {
    const total = db.prepare("SELECT COUNT(*) as count FROM matches").get().count;
    const scheduled = db.prepare("SELECT COUNT(*) as count FROM matches WHERE status = 'scheduled'").get().count;
    const live = db.prepare("SELECT COUNT(*) as count FROM matches WHERE status = 'live'").get().count;
    const finished = db.prepare("SELECT COUNT(*) as count FROM matches WHERE status = 'finished'").get().count;
    
    console.log(`Total Matches: ${total}`);
    console.log(`Scheduled: ${scheduled}`);
    console.log(`Live: ${live}`);
    console.log(`Finished: ${finished}`);
    
    if (total > 0) {
        const samples = db.prepare("SELECT homeTeam, awayTeam, status, timestamp, startTimestamp FROM matches LIMIT 5").all();
        console.log('Sample Matches:', JSON.stringify(samples, null, 2));
    }
} catch (e) {
    console.error('Error checking DB:', e.message);
} finally {
    db.close();
}
