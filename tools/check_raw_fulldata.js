const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Matrix22!', host: 'localhost', port: 5432, database: 'postgres' });

async function run() {
    try {
        const res = await pool.query("SELECT id, fulldata FROM matches WHERE status = 'scheduled' LIMIT 1");
        if (res.rows.length > 0) {
            const m = res.rows[0];
            console.log(`Match ID: ${m.id}`);
            const data = m.fulldata;
            console.log("Keys in fulldata:", Object.keys(data));
            if (data.odds_movement_24h) {
                console.log("odds_movement_24h:", data.odds_movement_24h);
            } else {
                console.log("odds_movement_24h is MISSING");
            }
        } else {
            console.log("No scheduled matches found.");
        }
        pool.end();
    } catch (err) {
        console.error(err.message);
        pool.end();
    }
}
run();
