const Database = require('better-sqlite3');
const db = new Database('c:/Users/HAMDI/Desktop/stitch/data/historical_archive.sqlite');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
for (const t of tables) {
    try {
        const row = db.prepare(`SELECT * FROM ${t.name} LIMIT 1`).get();
        console.log(`Table ${t.name} SAMPLE:`, row);
    } catch(e) { console.log(`Error reading ${t.name}:`, e.message); }
}
