const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'historical_archive.sqlite');
const db = new Database(dbPath);

try {
    const count = db.prepare('SELECT COUNT(*) as count FROM archive_matches').get().count;
    console.log(`Historical matches count: ${count}`);
    
    const statsCount = db.prepare('SELECT COUNT(*) as count FROM archive_matches WHERE stats_blob IS NOT NULL').get().count;
    console.log(`Matches with stats: ${statsCount}`);
    
    const latest = db.prepare('SELECT startTimestamp FROM archive_matches ORDER BY startTimestamp DESC LIMIT 1').get();
    console.log(`Latest match date: ${new Date(latest.startTimestamp * 1000).toISOString()}`);
} catch (e) {
    console.error('Error:', e.message);
} finally {
    db.close();
}
