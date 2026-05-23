const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/tactical.db');
const db = new Database(dbPath);

console.log("Teams in registry matching Jabalain or Diriyah or Draih:");
const teams = db.prepare(`SELECT * FROM team_registry WHERE name LIKE '%Jabal%' OR name LIKE '%Diri%' OR name LIKE '%Draih%'`).all();
console.table(teams);

console.log("Matches matching Jabalain or Diriyah or Draih:");
const matches = db.prepare(`SELECT homeTeam, awayTeam, league, startTimestamp, home_win_probability, away_win_probability, draw_probability FROM matches WHERE homeTeam LIKE '%Jabal%' OR awayTeam LIKE '%Jabal%' OR homeTeam LIKE '%Diri%' OR awayTeam LIKE '%Diri%' ORDER BY timestamp DESC LIMIT 10`).all();
console.table(matches);
