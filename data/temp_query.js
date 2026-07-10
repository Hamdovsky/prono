const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');
const rows = db.prepare('SELECT id, homeTeam, awayTeam, league, startTimestamp, status FROM matches ORDER BY startTimestamp DESC LIMIT 30').all();
rows.forEach(r => {
    const ts = r.startTimestamp > 1e11 ? r.startTimestamp : r.startTimestamp * 1000;
    console.log(r.id, r.homeTeam, 'vs', r.awayTeam, r.league, 'ts:', ts, 'tsDate:', new Date(ts).toISOString(), r.status);
});
