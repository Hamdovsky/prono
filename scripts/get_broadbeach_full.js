const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data/tactical.db');

db.get("SELECT * FROM matches WHERE homeTeam LIKE '%Broadbeach%' OR awayTeam LIKE '%Broadbeach%' ORDER BY id DESC LIMIT 1", (err, row) => {
    if (err) {
        console.error(err);
    } else {
        console.log(JSON.stringify(row, null, 2));
    }
    db.close();
});
