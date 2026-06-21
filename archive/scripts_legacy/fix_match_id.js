const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../data', 'tactical.db');

if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ Database not found at ${DB_PATH}`);
    process.exit(1);
}

const db = new Database(DB_PATH);

console.log('🚀 Starting Migration: Adding matchId to matches table...');

try {
    // 1. Add the column
    db.exec("ALTER TABLE matches ADD COLUMN matchId TEXT");
    console.log('✅ Column matchId added to matches table.');
} catch (e) {
    if (e.message.includes('duplicate column name')) {
        console.log('ℹ️ Column matchId already exists.');
    } else {
        console.error('❌ Error adding column:', e.message);
    }
}

try {
    // 2. Sync matchId with id
    const result = db.prepare("UPDATE matches SET matchId = id WHERE matchId IS NULL").run();
    console.log(`✅ Synced ${result.changes} rows (matchId = id).`);
} catch (e) {
    console.error('❌ Error syncing data:', e.message);
}

db.close();
console.log('🎉 Migration complete.');
