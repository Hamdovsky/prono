const DB = require('better-sqlite3');
const db = new DB('./data/tactical.db');

try {
    const rows = db.prepare('SELECT homeTeam, awayTeam, expected_score, xgboost_prediction_data FROM matches WHERE expected_score = ? LIMIT 10').all('3 - 0');
    rows.forEach(r => {
        let xgH = 'N/A', xgA = 'N/A';
        try { 
            const d = JSON.parse(r.xgboost_prediction_data || '{}'); 
            xgH = d.raw_xg_h; xgA = d.raw_xg_a;
        } catch(e) {}
        console.log(`${r.homeTeam} vs ${r.awayTeam}: ${r.expected_score} | xG: ${xgH} vs ${xgA}`);
    });
} catch (e) { console.error(e.message); }
