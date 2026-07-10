const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');
const rows = db.prepare("SELECT id, prediction, expected_score, home_win_probability, draw_probability, away_win_probability, ou_25_prob FROM matches WHERE source = 'bsd' LIMIT 5").all();
console.log(JSON.stringify(rows, null, 2));
const nullExpected = db.prepare("SELECT COUNT(*) as cnt FROM matches WHERE expected_score IS NULL AND source IN ('bsd', 'free_fallback')").get();
console.log('Matches with null expected_score:', nullExpected);
db.close();
