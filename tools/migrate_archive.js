const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite');
const db = new Database(DB_PATH);

try {
    const tableInfo = db.prepare("PRAGMA table_info(archive_matches)").all();
    const columns = tableInfo.map(c => c.name);
    console.log('Columns:', columns.join(', '));
    
    // Auto-migration
    const required = ['sofascore_id', 'homeTeam', 'awayTeam', 'scoreHome', 'scoreAway', 'league', 'season', 'match_date', 'startTimestamp', 'status', 'tournament'];
    for (const col of required) {
        if (!columns.includes(col)) {
            console.log(`➕ Adding column: ${col}`);
            db.exec(`ALTER TABLE archive_matches ADD COLUMN ${col} TEXT`);
        }
    }
    console.log('✅ Migration COMPLETED');
} catch (e) {
    console.error('❌ Migration FAILED:', e.message);
}
db.close();
