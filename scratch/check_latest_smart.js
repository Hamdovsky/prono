const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');
const matches = db.prepare(`
    SELECT homeTeam, awayTeam, scoreHome, scoreAway, prediction, tournament_name, status
    FROM matches 
    WHERE status = 'finished'
    AND prediction IS NOT NULL 
    AND prediction != 'NO BET'
    ORDER BY timestamp DESC LIMIT 5
`).all();
console.log('Latest Smart Picks results:', matches);
db.close();
