const D = require('better-sqlite3');
const db = new D('data/tactical.db');

const today = new Date('2026-05-15');
const toKey = (d) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};
const todayStr = toKey(today);

console.log(`Current Today: ${todayStr}`);

const getMatchDate = (m) => {
    let dateMs = null;
    if (m.startTimestamp) {
        dateMs = m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000;
    }
    if (!dateMs) return null;
    const d = new Date(dateMs);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const matches = db.prepare('SELECT homeTeam, awayTeam, startTimestamp FROM matches WHERE startTimestamp >= 1778800000').all();

console.log(`Total candidates: ${matches.length}`);

const leaked = matches.filter(m => {
    const matchDayStr = getMatchDate(m);
    return matchDayStr !== todayStr;
});

console.log(`Leaked matches (not Today): ${leaked.length}`);
if (leaked.length > 0) {
    console.log("Sample leaked:");
    leaked.slice(0, 10).forEach(m => {
        console.log(`  ${m.homeTeam} vs ${m.awayTeam} | ${getMatchDate(m)}`);
    });
}
