const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');

const rows = db.prepare("SELECT * FROM matches WHERE (homeTeam LIKE '%Falkenberg%')").all();
console.log(JSON.stringify(rows[0], null, 2));
db.close();
