const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/tactical.db');
console.log(`Checking SQLite at: ${dbPath}`);

try {
    const db = new Database(dbPath);
    const rows = db.prepare("SELECT id, homeTeam, awayTeam, league FROM matches WHERE league LIKE '%Premier League 2%'").all();
    console.log(`Found ${rows.length} matches in SQLite.`);
    rows.slice(0, 5).forEach(r => {
        console.log(`- [${r.id}] ${r.homeTeam} vs ${r.awayTeam} (${r.league})`);
    });
} catch (e) {
    console.error("Error reading SQLite:", e.message);
}
