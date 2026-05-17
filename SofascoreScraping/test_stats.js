const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/tactical.db');
const db = new sqlite3.Database(dbPath);

console.log("Checking for stats in tactical.db...");

db.all('SELECT id, homeTeam, awayTeam, status, fullData FROM matches ORDER BY last_updated DESC LIMIT 10;', (err, rows) => {
    if (err) {
        console.error(err);
        return;
    }

    let foundStats = false;
    for (const row of rows) {
        try {
            const data = JSON.parse(row.fullData);
            if (data.stats && data.stats.length > 0) {
                console.log(`\n✅ Stats found for match: ${row.homeTeam} vs ${row.awayTeam} (${row.status})`);
                console.log(JSON.stringify(data.stats, null, 2));
                foundStats = true;
                break;
            } else if (data.lineups && (data.lineups.home.length > 0 || data.lineups.away.length > 0)) {
                console.log(`\n✅ Lineups found for match: ${row.homeTeam} vs ${row.awayTeam}`);
            }
        } catch (e) { }
    }

    if (!foundStats) {
        console.log("❌ No stats found in the latest 10 scraped matches.");

        // Print the first match to see what data it actually has
        if (rows.length > 0) {
            console.log("\nSample fullData of the latest match:");
            console.log(JSON.stringify(JSON.parse(rows[0].fullData), null, 2));
        }
    }

    db.close();
});
