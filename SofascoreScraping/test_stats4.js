const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const dbPath = path.resolve(__dirname, '../data/tactical.db');
const db = new sqlite3.Database(dbPath);

console.log("Searching for any match with stats...");
db.all("SELECT id, status, fullData FROM matches WHERE status IN ('live', 'finished') OR fullData LIKE '%\"stats\":[{%' LIMIT 5;", (err, rows) => {
    if (err) return console.error(err);
    const results = rows.map(r => {
        try {
            let d = JSON.parse(r.fullData);
            let hasStats = d.stats && d.stats.length > 0 ? d.stats.length : 0;
            return {
                match_id: r.id,
                status: r.status,
                stats_count: hasStats,
                stats_preview: d.stats ? d.stats.slice(0, 3) : []
            };
        } catch (e) {
            return { match_id: r.id, error: e.message };
        }
    });
    fs.writeFileSync('stats_result2.json', JSON.stringify(results, null, 2));
    db.close();
});
