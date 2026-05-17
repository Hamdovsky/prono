const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Matrix22!', host: 'localhost', port: 5432, database: 'postgres' });

async function run() {
    try {
        const res = await pool.query("SELECT id, fulldata FROM matches WHERE fulldata->>'odds_movement_24h' IS NOT NULL LIMIT 5");
        console.log(`🔍 Found ${res.rows.length} matches with Odds Movement data.`);
        res.rows.forEach(r => {
            const move = r.fulldata.odds_movement_24h;
            console.log(`   Match ${r.id}: Move H=${move.h_pct.toFixed(2)}% | a=${move.a_pct.toFixed(2)}% | Age=${move.age_hours}h`);
        });
        pool.end();
    } catch (err) {
        console.error(err.message);
        pool.end();
    }
}
run();
