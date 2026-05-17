const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');
const row = db.prepare('SELECT ou_25_prob FROM matches WHERE ou_25_prob IS NOT NULL LIMIT 1').get();
console.log('ou_25_prob:', row.ou_25_prob);
db.close();
