const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Matrix22!', host: 'localhost', port: 5432, database: 'postgres' });

async function run() {
    try {
        const res = await pool.query("SELECT COUNT(*) FROM matches WHERE status = 'finished' AND (fulldata->>'h2h_data' IS NOT NULL OR fulldata->>'h2h_win_rate' IS NOT NULL)");
        console.log('Finished matches with H2H in Postgres:', res.rows[0].count);
        
        const res2 = await pool.query("SELECT COUNT(*) FROM matches WHERE status = 'finished' AND (fulldata->>'odds_movement_24h' IS NOT NULL)");
        console.log('Finished matches with Line Move in Postgres:', res2.rows[0].count);
        
        pool.end();
    } catch (err) {
        console.error(err.message);
        pool.end();
    }
}
run();
