const Database = require('better-sqlite3');
const path = require('path');
const archivePath = path.join(__dirname, '../data/historical_archive.sqlite');
const db = new Database(archivePath);

try {
    const row = db.prepare("SELECT COUNT(*) as count FROM archive_matches").get();
    console.log(`Archive Count: ${row.count}`);
    
    const sample = db.prepare("SELECT * FROM archive_matches LIMIT 1").get();
    console.log("Sample keys:", Object.keys(sample));
} catch (e) {
    console.error("Error:", e.message);
}
db.close();
