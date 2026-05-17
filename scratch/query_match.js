const Database = require('better-sqlite3');
const db = new Database('stitch_main.db');

const rows = db.prepare("SELECT * FROM matches WHERE (homeTeam LIKE '%Falkenberg%' AND awayTeam LIKE '%Norrkoping%') OR (homeTeam LIKE '%Norrkoping%' AND awayTeam LIKE '%Falkenberg%')").all();
console.log(JSON.stringify(rows, null, 2));
db.close();
