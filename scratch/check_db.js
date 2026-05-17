const D = require('better-sqlite3');
const db = new D('data/tactical.db', { readonly: true });
const now = Math.floor(Date.now() / 1000);
const todayStart = Math.floor(new Date().setHours(0,0,0,0) / 1000);
const todayEnd   = Math.floor(new Date().setHours(23,59,59,999) / 1000);
const tomorrowEnd = todayEnd + 86400;

console.log('Today window:', new Date(todayStart*1000).toISOString(), '->', new Date(todayEnd*1000).toISOString());

// Matches with valid timestamps (not epoch 0)
const valid = db.prepare(`SELECT homeTeam, awayTeam, status, startTimestamp, home_win_probability 
    FROM matches WHERE startTimestamp > 1700000000 ORDER BY startTimestamp ASC LIMIT 20`).all();
console.log('\nMatches with valid timestamps:', valid.length);
valid.forEach(m => console.log(`  ${new Date(m.startTimestamp*1000).toISOString().slice(0,16)} | ${m.homeTeam} vs ${m.awayTeam} | ${m.status} | prob=${m.home_win_probability}`));

// Today specifically
const today = db.prepare(`SELECT COUNT(*) as c FROM matches WHERE startTimestamp BETWEEN ? AND ?`).get(todayStart, todayEnd);
console.log('\nToday matches:', today.c);
const tomorrow = db.prepare(`SELECT COUNT(*) as c FROM matches WHERE startTimestamp BETWEEN ? AND ?`).get(todayEnd, tomorrowEnd);
console.log('Tomorrow matches:', tomorrow.c);

// What's the date range of stored matches?
const range = db.prepare(`SELECT MIN(startTimestamp) as minT, MAX(startTimestamp) as maxT FROM matches WHERE startTimestamp > 1000000`).get();
console.log('\nDB date range:', new Date(range.minT*1000).toISOString(), '->', new Date(range.maxT*1000).toISOString());

db.close();
