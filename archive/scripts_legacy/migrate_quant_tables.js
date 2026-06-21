const db = require('better-sqlite3')('data/tactical.db');

const tables = [
    `CREATE TABLE IF NOT EXISTS odds_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT,
        odds_home REAL,
        odds_draw REAL,
        odds_away REAL,
        type TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS quant_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT,
        taken_odds REAL,
        closing_odds REAL,
        clv REAL,
        pnl REAL,
        stake REAL,
        ev_at_bet REAL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
];

for (const sql of tables) {
    try {
        db.exec(sql);
        console.log(`Executed: ${sql.substring(0, 50)}...`);
    } catch (e) {
        console.error(`Error:`, e.message);
    }
}
console.log("Migration complete.");
