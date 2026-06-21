const db = require('better-sqlite3')('data/tactical.db');

const columns = [
    'true_prob_home REAL',
    'true_prob_draw REAL',
    'true_prob_away REAL',
    'true_prob_ou25 REAL',
    'true_prob_btts REAL',
    'ev_draw REAL',
    'ev_away REAL',
    'clv_value REAL',
    'kelly_stake REAL'
];

for (const col of columns) {
    try {
        db.exec(`ALTER TABLE matches ADD COLUMN ${col}`);
        console.log(`Added column ${col}`);
    } catch (e) {
        if (e.message.includes('duplicate column name')) {
            console.log(`Column ${col} already exists.`);
        } else {
            console.error(`Error adding column ${col}:`, e.message);
        }
    }
}
