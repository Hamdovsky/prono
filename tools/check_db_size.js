const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'tactical.db');
const db = new Database(DB_PATH);

try {
    const row = db.prepare("SELECT length(fullData) as size FROM matches LIMIT 1").get();
    console.log(`Average fullData size: ${row ? row.size : 0} bytes`);
    
    const count = db.prepare("SELECT COUNT(*) as count FROM matches WHERE status = 'scheduled'").get().count;
    console.log(`Total scheduled matches: ${count}`);
    
    // Check for large blobs
    const large = db.prepare("SELECT COUNT(*) as count FROM matches WHERE length(fullData) > 50000").get().count;
    console.log(`Matches with >50KB fullData: ${large}`);
} catch (e) {
    console.error(e);
}
