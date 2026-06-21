const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data/tactical.db');

db.get("SELECT * FROM matches LIMIT 1", (err, row) => {
    if (err) {
        console.error(err);
    } else {
        console.log(Object.keys(row));
    }
    db.close();
});
