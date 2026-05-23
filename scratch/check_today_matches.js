const Database = require('better-sqlite3');
const db = new Database('data/tactical.db', { readonly: true });
const todayStart = Math.floor(new Date('2026-05-23T00:00:00Z').getTime() / 1000);
const todayEnd = todayStart + 86400;

console.log('Today starts at:', todayStart, new Date(todayStart * 1000).toISOString());
console.log('Today ends at:', todayEnd, new Date(todayEnd * 1000).toISOString());

const matches = db.prepare('SELECT id, homeTeam, awayTeam, status, startTimestamp FROM matches WHERE startTimestamp >= ? AND startTimestamp < ?').all(todayStart, todayEnd);
console.log(`Found ${matches.length} matches for today in tactical.db:`);
matches.forEach(m => {
    console.log(`- ${m.homeTeam} vs ${m.awayTeam} | Status: ${m.status} | Time: ${new Date(m.startTimestamp * 1000).toISOString()} (TS: ${m.startTimestamp})`);
});

db.close();
