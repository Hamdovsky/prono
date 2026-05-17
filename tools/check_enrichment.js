const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'tactical.db');
const db = new Database(DB_PATH);

try {
    const total = db.prepare("SELECT COUNT(*) as count FROM matches WHERE status = 'scheduled'").get().count;
    const enriched = db.prepare("SELECT COUNT(*) as count FROM matches WHERE status = 'scheduled' AND xgboost_prediction_data IS NOT NULL").get().count;
    console.log(`Scheduled Matches: ${total}`);
    console.log(`Enriched Matches: ${enriched}`);
    console.log(`Needs Enrichment: ${total - enriched}`);
} catch (e) {
    console.error(e);
}
