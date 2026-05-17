const Database = require('better-sqlite3');
const path = require('path');
const dbPath = 'c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/historical_archive.sqlite';
const db = new Database(dbPath);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables);

tables.forEach(table => {
    const info = db.prepare(`PRAGMA table_info(${table.name})`).all();
    
    // Check for date columns
    const dateCol = info.find(c => c.name.toLowerCase().includes('date') || c.name.toLowerCase().includes('time') || c.name.toLowerCase().includes('timestamp'));
    if (dateCol) {
        const range = db.prepare(`SELECT MIN(${dateCol.name}) as min_date, MAX(${dateCol.name}) as max_date FROM ${table.name}`).get();
        if (range.min_date) {
            // Assume seconds if < 10^12, else milliseconds
            const factor = range.min_date > 10000000000 ? 1 : 1000;
            const minDate = new Date(range.min_date * factor).toISOString();
            const maxDate = new Date(range.max_date * factor).toISOString();
            console.log(`Date range for ${table.name} (based on ${dateCol.name}):`, { minDate, maxDate });
        }
    }
    
    const count = db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
    console.log(`Count for ${table.name}:`, count);
});
