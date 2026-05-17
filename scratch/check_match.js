const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');
const matches = db.prepare("SELECT homeTeam, awayTeam, scoreHome, scoreAway, prediction, expected_score FROM matches WHERE homeTeam LIKE '%Atromitos%' OR awayTeam LIKE '%Atromitos%'").all();
console.log(JSON.stringify(matches, null, 2));
db.close();
