const db = require('better-sqlite3')('data/tactical.db');
const rows = db.prepare(`SELECT * FROM matches WHERE status IN ('finished', 'ft') LIMIT 5`).all();
console.log(JSON.stringify(rows, null, 2));
