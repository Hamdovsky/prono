const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data/tactical.db');

db.all("SELECT id, homeTeam, awayTeam, scoreHome, scoreAway, home_xg, away_xg, home_win_probability, away_win_probability, draw_probability, home_motivation, away_motivation, league FROM matches WHERE homeTeam LIKE '%Broadbeach%' OR awayTeam LIKE '%Broadbeach%' ORDER BY date DESC LIMIT 2", (err, rows) => {
    if (err) {
        console.error(err);
    } else {
        console.log(JSON.stringify(rows, null, 2));
    }
    db.close();
});
