const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join('c:', 'Users', 'HAMDI', 'Desktop', 'HamdiProno', 'stitch', 'stitch_main.db');
const db = new sqlite3.Database(dbPath);

const today = '2026-05-04';

db.all("SELECT * FROM matches WHERE date(startTimestamp, 'unixepoch') = ? OR date(datetime(startTimestamp/1000, 'unixepoch')) = ? OR date(datetime(timestamp, 'unixepoch')) = ?", [today, today, today], (err, rows) => {
    if (err) {
        console.error(err);
        return;
    }
    console.log(JSON.stringify(rows, null, 2));
    db.close();
});
