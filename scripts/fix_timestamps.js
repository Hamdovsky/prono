/**
 * FIX: Update startTimestamp from fullData JSON for matches with timestamp = 0 or NULL
 * Run this once to repair the DB.
 */
const D = require('better-sqlite3');
const db = new D('data/tactical.db');

console.log('🔧 Repairing startTimestamp from fullData...');

const broken = db.prepare(`
    SELECT id, fullData FROM matches 
    WHERE (startTimestamp IS NULL OR startTimestamp = 0) AND fullData IS NOT NULL
`).all();

console.log(`Found ${broken.length} matches with missing timestamps`);

let fixed = 0;
const update = db.prepare(`UPDATE matches SET startTimestamp = ? WHERE id = ?`);

        const fixAll = db.transaction(() => {
    for (const row of broken) {
        try {
            const data = JSON.parse(row.fullData);
            // Try startTimestamp first, then parse ISO timestamp field
            let ts = data.startTimestamp;
            if (!ts && data.timestamp) {
                ts = Math.floor(new Date(data.timestamp).getTime() / 1000);
            }
            if (ts && ts > 1000000000) {
                update.run(ts, row.id);
                fixed++;
            }
        } catch (e) {}
    }
});

fixAll();
console.log(`✅ Fixed ${fixed}/${broken.length} timestamps`);

// Verify
const todayStart = Math.floor(new Date().setHours(0,0,0,0) / 1000);
const tomorrowEnd = Math.floor(new Date().setHours(23,59,59,999) / 1000) + 86400;
const todayCount = db.prepare(`SELECT COUNT(*) as c FROM matches WHERE startTimestamp BETWEEN ? AND ? AND status = 'scheduled'`).get(todayStart, tomorrowEnd);
console.log(`📅 Today+Tomorrow scheduled matches: ${todayCount.c}`);

// Show sample
const sample = db.prepare(`SELECT homeTeam, awayTeam, startTimestamp FROM matches WHERE startTimestamp BETWEEN ? AND ? AND status = 'scheduled' ORDER BY startTimestamp ASC LIMIT 10`).all(todayStart, tomorrowEnd);
sample.forEach(m => console.log(`  ${new Date(m.startTimestamp*1000).toLocaleString('fr-FR')} | ${m.homeTeam} vs ${m.awayTeam}`));

db.close();
