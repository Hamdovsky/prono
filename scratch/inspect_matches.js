const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');
const rows = db.prepare("SELECT id, homeTeam, awayTeam, status, timestamp, startTimestamp, odds_home, odds_away, source FROM matches WHERE source = 'africanobet'").all();
console.log(JSON.stringify(rows, null, 2));
db.close();
