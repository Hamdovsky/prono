const DB = require('better-sqlite3');
const db = new DB('./data/tactical.db');
try {
    const rows = db.prepare('SELECT id, homeTeam, awayTeam, expected_score, fullData FROM matches WHERE expected_score = "3 - 0" LIMIT 5').all();
    rows.forEach(r => {
        console.log(`${r.homeTeam} vs ${r.awayTeam}: ${r.expected_score}`);
    });
} catch(e) {
    console.error("ERROR DB: " + e.message);
}
