const Database = require('better-sqlite3');
const db = new Database('c:/Users/HAMDI/Desktop/stitch/data/historical_archive.sqlite');
const schema = db.prepare("PRAGMA table_info(stats_history)").all();
console.log('Schema for stats_history:', schema);
const sample = db.prepare("SELECT * FROM stats_history LIMIT 1").get();
console.log('Sample data:', sample);
if (sample.stats_blob) {
    try {
        const stats = JSON.parse(sample.stats_blob);
        console.log('Stats Blob Keys:', Object.keys(stats));
        if (stats.referee) console.log('Referee Data Found:', stats.referee);
    } catch(e) { console.log('Stats blob not JSON'); }
}
