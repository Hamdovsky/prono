const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const db = new sqlite3.Database('data/tactical.db');

db.get("SELECT * FROM matches WHERE (homeTeam LIKE '%Broadbeach%' AND awayTeam LIKE '%Robina%') OR (homeTeam LIKE '%Robina%' AND awayTeam LIKE '%Broadbeach%') LIMIT 1", (err, row) => {
    if (err) {
        console.error(err);
    } else if (row) {
        const out = {
            homeTeam: row.homeTeam,
            awayTeam: row.awayTeam,
            scoreHome: row.scoreHome,
            scoreAway: row.scoreAway,
            date: row.date,
            home_win_probability: row.home_win_probability,
            draw_probability: row.draw_probability,
            away_win_probability: row.away_win_probability,
            home_xg: row.home_xg,
            away_xg: row.away_xg,
            home_motivation: row.home_motivation,
            away_motivation: row.away_motivation,
            xgboost_confidence: row.xgboost_confidence,
            match_type: row.match_type,
            predicted_score: row.predicted_score,
            adjusted_prediction: row.adjusted_prediction
        };
        fs.writeFileSync('tmp/broadbeach_final.json', JSON.stringify(out, null, 2));
        console.log("Data dumped to tmp/broadbeach_final.json");
    } else {
        console.log("Match not found");
    }
    db.close();
});
