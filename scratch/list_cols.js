const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');
const cols = db.prepare('PRAGMA table_info(matches)').all();
console.log(cols.map(c => c.name));
db.close();
