const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data/tactical.db');

db.get("SELECT news_sentiment, market_signals, match_type FROM matches WHERE homeTeam LIKE '%Broadbeach%'", (err, row) => {
    if (err) console.error(err);
    else console.log(JSON.stringify(row, null, 2));
    db.close();
});
