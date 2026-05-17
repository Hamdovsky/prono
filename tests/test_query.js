const DB = require('better-sqlite3');
const db = new DB('./data/tactical.db');
const rows = db.prepare('SELECT id, homeTeam, awayTeam, expected_score, xgboost_prediction_data FROM matches WHERE expected_score = "3 - 0" LIMIT 5').all();
rows.forEach(r => {
    let data = {};
    try { data = JSON.parse(r.xgboost_prediction_data || '{}'); } catch(e) {}
    console.log(`${r.homeTeam} vs ${r.awayTeam}: ${r.expected_score} -> xG_H: ${data.raw_xg_h} vs xG_A: ${data.raw_xg_a}`);
});
