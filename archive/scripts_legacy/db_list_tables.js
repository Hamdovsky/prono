const Database = require('better-sqlite3');
const db = new Database('c:/Users/HAMDI/Desktop/stitch/data/historical_archive.sqlite');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('ALL TABLES:', tables.map(t => t.name).join(', '));
