const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data/tactical.db');

db.get("SELECT * FROM matches WHERE (homeTeam LIKE '%Broadbeach%' AND awayTeam LIKE '%Robina%') OR (homeTeam LIKE '%Robina%' AND awayTeam LIKE '%Broadbeach%') LIMIT 1", (err, row) => {
    if (err) {
        console.error(err);
    } else if (row) {
        console.log(JSON.stringify(row, null, 2));
    } else {
        console.log("Match not found in tactical.db");
    }
    db.close();
});
