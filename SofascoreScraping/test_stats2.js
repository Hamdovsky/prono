const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, '../data/tactical.db');
const db = new sqlite3.Database(dbPath);

console.log("Analyzing last 10 matches...");
db.all('SELECT id, status, fullData FROM matches ORDER BY last_updated DESC LIMIT 10;', (err, rows) => {
    if (err) return console.error(err);
    rows.forEach(r => {
        let d = JSON.parse(r.fullData);
        let hasStats = d.stats && d.stats.length > 0 ? d.stats.length : 0;
        console.log(`[${r.status}] Match ${r.id}: hasStats=${hasStats}, keys=${Object.keys(d).join(',')}`);
    });
    db.close();
});
