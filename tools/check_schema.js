const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite');
const db = new Database(DB_PATH);

try {
    const tableInfo = db.prepare("PRAGMA table_info(archive_matches)").all();
    console.log('📊 Schema for archive_matches:', JSON.stringify(tableInfo, null, 2));
} catch (e) {
    console.log('❌ Error reading schema:', e.message);
}
db.close();
