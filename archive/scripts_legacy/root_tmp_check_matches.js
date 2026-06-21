const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');
const rows = db.prepare("SELECT id, homeTeam, awayTeam, league, startTimestamp, status FROM matches WHERE date(startTimestamp/1000,'unixepoch') = '2026-06-16' OR date(startTimestamp/1000,'unixepoch') = '2026-06-17'").all();
console.log('Today/tomorrow matches:', rows.length);
rows.forEach(r => console.log(' ', r.id, r.homeTeam, 'vs', r.awayTeam, r.league, new Date(r.startTimestamp).toISOString(), r.status));
db.close();
