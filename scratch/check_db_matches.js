const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve('c:/Users/HAMDI/Desktop/HamdiProno/stitch/core/database.sqlite');
const db = new sqlite3.Database(dbPath);

db.all("SELECT id, homeTeam, awayTeam, home_win_probability, away_win_probability, draw_probability, insufficient_data, ai_source FROM matches LIMIT 20", (err, rows) => {
    if (err) {
        console.error(err);
        return;
    }
    console.table(rows);
    db.close();
});
