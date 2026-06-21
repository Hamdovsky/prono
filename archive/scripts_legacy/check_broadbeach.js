const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data/tactical.db');

db.all("SELECT * FROM matches WHERE homeTeam LIKE '%Broadbeach%' OR awayTeam LIKE '%Broadbeach%' LIMIT 5", (err, rows) => {
    if (err) {
        console.error(err);
    } else {
        console.log(JSON.stringify(rows, null, 2));
    }
    db.close();
});
