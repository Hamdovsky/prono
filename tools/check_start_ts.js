const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'tactical.db');
const db = new Database(DB_PATH);

try {
    const sample = db.prepare("SELECT id, homeTeam, awayTeam, startTimestamp, timestamp FROM matches WHERE status = 'scheduled' LIMIT 5").all();
    console.log('Sample matches:', JSON.stringify(sample, null, 2));
    
    const nullStart = db.prepare("SELECT COUNT(*) as count FROM matches WHERE status = 'scheduled' AND startTimestamp IS NULL").get().count;
    console.log(`Scheduled matches with NULL startTimestamp: ${nullStart}`);
} catch (e) {
    console.error(e);
}
