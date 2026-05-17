const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const dbPath = path.resolve(__dirname, '../data/tactical.db');
const db = new sqlite3.Database(dbPath);

db.all('SELECT id, status, fullData FROM matches ORDER BY last_updated DESC LIMIT 10;', (err, rows) => {
    if (err) return console.error(err);
    const results = rows.map(r => {
        try {
            let d = JSON.parse(r.fullData);
            let hasStats = d.stats && d.stats.length > 0 ? d.stats.length : 0;
            return {
                match_id: r.id,
                status: r.status,
                stats_count: hasStats,
                stats_preview: d.stats ? d.stats.slice(0, 2) : [],
                keys: Object.keys(d)
            };
        } catch (e) {
            return { match_id: r.id, error: e.message };
        }
    });
    fs.writeFileSync('stats_result.json', JSON.stringify(results, null, 2));
    db.close();
});
