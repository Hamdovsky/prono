const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');
const rows = db.prepare('SELECT DISTINCT status FROM matches').all();
console.log(rows);
db.close();
