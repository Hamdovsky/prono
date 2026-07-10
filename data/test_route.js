const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');
const startOfToday = new Date().setHours(0,0,0,0);
const endOfRange = startOfToday + (3 * 24 * 60 * 60 * 1000);
const sevenDaysAgo = new Date(Date.now() - 7*24*60*60*1000).getTime();
console.log('startOfToday:', new Date(startOfToday).toISOString());
console.log('endOfRange:', new Date(endOfRange).toISOString());
console.log('sevenDaysAgo:', new Date(sevenDaysAgo).toISOString());
const all = db.prepare('SELECT * FROM matches WHERE status IN (\"scheduled\",\"NOT_STARTED\",\"NS\")').all();
console.log('scheduled/NOT_STARTED/NS count:', all.length);
let filtered = all.filter(m => {
    let rawTs = m.startTimestamp;
    if (!rawTs || rawTs === 0) {
        try { const d = JSON.parse(m.fullData || '{}'); if (d.startTimestamp) rawTs = d.startTimestamp; } catch(e) {}
    }
    if (!rawTs || rawTs === 0) return false;
    let tsMs = typeof rawTs === 'string' && rawTs.includes('T') ? new Date(rawTs).getTime() : (parseInt(rawTs) > 1e11 ? parseInt(rawTs) : parseInt(rawTs) * 1000);
    return tsMs >= startOfToday && tsMs <= endOfRange;
});
console.log('Primary filter (today+3d):', filtered.length);
if (filtered.length === 0) {
    const all2 = db.prepare('SELECT * FROM matches WHERE status IN (\"scheduled\",\"NOT_STARTED\",\"NS\")').all();
    filtered = all2.filter(m => {
        let rawTs = m.startTimestamp;
        if (!rawTs || rawTs === 0) {
            try { const d = JSON.parse(m.fullData || '{}'); if (d.startTimestamp) rawTs = d.startTimestamp; } catch(e) {}
        }
        if (!rawTs || rawTs === 0) return false;
        let tsMs = typeof rawTs === 'string' && rawTs.includes('T') ? new Date(rawTs).getTime() : (parseInt(rawTs) > 1e11 ? parseInt(rawTs) : parseInt(rawTs) * 1000);
        return !isNaN(tsMs) && tsMs >= sevenDaysAgo;
    });
    console.log('Fallback filter (7d ago):', filtered.length);
    filtered.forEach(m => console.log('  ', m.homeTeam, 'vs', m.awayTeam, m.league, new Date(m.startTimestamp).toISOString()));
}
