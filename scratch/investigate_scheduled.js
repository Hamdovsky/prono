const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/tactical.db');
const db = new Database(dbPath);

console.log("Count of matches grouped by status:");
const stats = db.prepare(`SELECT status, COUNT(*) as count FROM matches GROUP BY status`).all();
console.table(stats);

console.log("\nRecent 'scheduled' matches:");
const recent = db.prepare(`
    SELECT homeTeam, awayTeam, status, startTimestamp, home_win_probability, away_win_probability 
    FROM matches 
    WHERE status IN ('scheduled', 'NOT_STARTED', 'NS', 'upcoming')
    ORDER BY startTimestamp DESC 
    LIMIT 10
`).all();
console.table(recent);

const maxProb = db.prepare(`
    SELECT homeTeam, awayTeam, status, home_win_probability, away_win_probability, draw_probability
    FROM matches 
    WHERE status IN ('scheduled', 'NOT_STARTED', 'NS', 'upcoming')
    ORDER BY MAX(home_win_probability, away_win_probability) DESC 
    LIMIT 10
`).all();
console.log("\nMatches with highest probabilities:");
console.table(maxProb);
