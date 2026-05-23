const database = require('../core/database');
const todayStr = '2026-05-19';

console.log(`Querying matches for ${todayStr}...`);
database.getMatchesByDate(todayStr).then(matches => {
    console.log(`Found ${matches.length} matches for today.`);
    if (matches.length > 0) {
        matches.forEach((m, i) => {
            console.log(`${i+1}. ${m.homeTeam} vs ${m.awayTeam} | League: ${m.league} | Status: ${m.status} | Timestamp: ${m.timestamp}`);
        });
    }
    database.db.close();
}).catch(e => {
    console.error('Error:', e);
});
