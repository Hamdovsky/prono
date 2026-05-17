const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');
const matches = db.prepare(`
    SELECT homeTeam, awayTeam, status, prediction, datetime(timestamp, 'unixepoch') as date 
    FROM matches 
    WHERE datetime(timestamp, 'unixepoch') >= datetime('now', '-24 hours')
    AND prediction IS NOT NULL
    AND prediction != 'NO BET'
`).all();
console.log('Matches with predictions in last 24h:', matches);
db.close();
