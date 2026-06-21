const path = require('path');
const dbPath = path.join(__dirname, '..', 'data', 'historical_archive.sqlite');
const db = new Database(dbPath);
const schema = db.prepare("PRAGMA table_info(archive_stats)").all();
console.log('Schema:', schema);
const sample = db.prepare("SELECT * FROM archive_stats LIMIT 1").get();
if (sample && sample.stats_blob) {
    try {
        const stats = JSON.parse(sample.stats_blob);
        console.log('Stats JSON Sample:', JSON.stringify(stats, null, 2).substring(0, 500));
    } catch(e) { console.log('Blob not JSON'); }
}
