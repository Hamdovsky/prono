const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'tactical.db');
const db = new Database(DB_PATH);

try {
    const rows = db.prepare("SELECT fullData FROM matches WHERE date(timestamp) = '2026-03-12' LIMIT 20").all();
    console.log('Actual Match Dates for those inserted today:');
    rows.forEach(r => {
        const data = JSON.parse(r.fullData);
        const ts = data.startTimestamp || data.timestamp || data.startTime;
        let dateObj;
        if (typeof ts === 'number') dateObj = new Date(ts * 1000);
        else dateObj = new Date(ts);
        
        console.log(`${data.homeTeam} vs ${data.awayTeam} | Start: ${dateObj.toISOString()}`);
    });

} catch (e) {
    console.error('Error:', e.message);
} finally {
    db.close();
}
