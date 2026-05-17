const Database = require('better-sqlite3');
const db = new Database('c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/tactical.db');
const schema = db.prepare("PRAGMA table_info(matches)").all();
console.log('Columns in matches table:', schema.map(c => c.name));
