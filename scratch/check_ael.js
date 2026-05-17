const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');
const matches = db.prepare("SELECT * FROM matches WHERE homeTeam LIKE '%AEL Novibet%'").all();
console.log(JSON.stringify(matches, null, 2));
db.close();
