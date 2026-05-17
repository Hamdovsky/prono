const Database = require('better-sqlite3');
const path = require('path');
const db = new Database('c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/tactical.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables);

for (const table of tables) {
    const schema = db.prepare(`PRAGMA table_info(${table.name})`).all();
    console.log(`Schema for ${table.name}:`, schema);
    const sample = db.prepare(`SELECT * FROM ${table.name} LIMIT 1`).get();
    console.log(`Sample for ${table.name}:`, sample);
}
