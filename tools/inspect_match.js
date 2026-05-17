const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'tactical.db');
const db = new Database(DB_PATH);

try {
    const row = db.prepare("SELECT fullData FROM matches WHERE date(timestamp) = '2026-03-12' LIMIT 1").get();
    if (row) {
        console.log('Sample Full Data (Today):');
        console.log(JSON.stringify(JSON.parse(row.fullData), null, 2));
    } else {
        console.log('No matches found for today in DB.');
    }
} catch (e) {
    console.error('Error:', e.message);
} finally {
    db.close();
}
