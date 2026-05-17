const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Matrix22!', host: 'localhost', port: 5432, database: 'postgres' });

async function run() {
    try {
        const res = await pool.query("SELECT id, hometeam, awayteam, prediction, confidence, probability_home, probability_draw, probability_away FROM matches WHERE id IN ('14372201', '14372199', '14372200')");
        console.log(`Checking ${res.rows.length} matches:`);
        res.rows.forEach(r => {
            console.log(`- [${r.id}] ${r.hometeam} vs ${r.awayteam} | Pred: ${r.prediction} | Conf: ${r.confidence}% | Probs: ${r.probability_home}/${r.probability_draw}/${r.probability_away}`);
        });
        pool.end();
    } catch (err) {
        console.error(err.message);
        pool.end();
    }
}
run();
