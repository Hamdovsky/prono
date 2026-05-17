const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve('c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/tactical.db');
const db = new Database(dbPath, { readonly: true });

try {
    const dates = db.prepare(`
        SELECT date(datetime(startTimestamp, 'unixepoch')) as d, count(*) as count 
        FROM matches 
        GROUP BY d 
        ORDER BY d DESC 
        LIMIT 10
    `).all();
    console.log("Match dates in database:", dates);
} catch (e) {
    console.error(e);
} finally {
    db.close();
}
