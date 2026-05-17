const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data/tactical.db');

db.get("SELECT * FROM matches WHERE (homeTeam LIKE '%Broadbeach%' AND awayTeam LIKE '%Robina%') OR (homeTeam LIKE '%Robina%' AND awayTeam LIKE '%Broadbeach%') LIMIT 1", (err, row) => {
    if (err) {
        console.error(err);
    } else if (row) {
        console.log("Match:", row.homeTeam, "vs", row.awayTeam);
        console.log("Probabilities:", `H: ${row.home_win_probability}% D: ${row.draw_probability}% A: ${row.away_win_probability}% OU25: ${row.ou_2_5_prob}%`);
        console.log("xG:", `H: ${row.home_xg} A: ${row.away_xg}`);
        console.log("Motivation:", `H: ${row.home_motivation} A: ${row.away_motivation}`);
        console.log("XGB Conf:", row.xgboost_confidence);
        console.log("Match Type:", row.match_type);
        console.log("Prediction:", row.model_prediction, row.adjusted_prediction);
    } else {
        console.log("Match not found in tactical.db");
    }
    db.close();
});
