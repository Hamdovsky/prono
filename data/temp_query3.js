const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');
console.log('Current time:', new Date().toISOString());
console.log('Current locale time:', new Date().toString());
console.log('startOfToday (local):', new Date(new Date().setHours(0,0,0,0)).toISOString());
console.log('startOfToday (local ms):', new Date().setHours(0,0,0,0));
console.log('');

// Count matches with valid timestamps for today
const startOfToday = new Date().setHours(0,0,0,0);
const endOfRange = startOfToday + 3*24*60*60*1000;
const sevenDaysAgo = new Date(Date.now() - 7*24*60*60*1000).getTime();

console.log('Using startOfToday:', new Date(startOfToday).toISOString(), 'ms:', startOfToday);
console.log('Using endOfRange:', new Date(endOfRange).toISOString(), 'ms:', endOfRange);
console.log('Using sevenDaysAgo:', new Date(sevenDaysAgo).toISOString(), 'ms:', sevenDaysAgo);
console.log('');

// Check all available startTimestamps
const all = db.prepare('SELECT id, homeTeam, awayTeam, league, startTimestamp, status FROM matches ORDER BY startTimestamp DESC').all();
console.log('All matches:');
all.forEach(r => {
    let tsMs = 0;
    if (r.startTimestamp > 0) {
        tsMs = r.startTimestamp > 1e11 ? r.startTimestamp : r.startTimestamp * 1000;
    }
    const withinRange = tsMs >= startOfToday && tsMs <= endOfRange;
    const inFallback = tsMs >= sevenDaysAgo;
    console.log(r.id, r.homeTeam, 'vs', r.awayTeam, 'tsMs:', tsMs, 'date:', new Date(tsMs).toISOString(), 'withinRange:', withinRange, 'inFallback:', inFallback, 'status:', r.status);
});
