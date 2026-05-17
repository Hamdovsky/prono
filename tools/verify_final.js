const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Matrix22!', host: 'localhost', port: 5432, database: 'postgres' });

async function run() {
    try {
        const res = await pool.query("SELECT id, fulldata FROM matches WHERE id = '14083372'");
        if (res.rows.length > 0) {
            const m = res.rows[0];
            console.log(`Match ID: ${m.id}`);
            const data = m.fulldata;
            const keys = Object.keys(data);
            if (keys.includes('odds_movement_24h')) {
                console.log("RESULT: YES_FOUND");
                console.log("Data:", JSON.stringify(data.odds_movement_24h));
            } else {
                console.log("RESULT: NO_MISSING");
            }
        } else {
            console.log("Match 14083372 not found in tactical DB.");
        }
        pool.end();
    } catch (err) {
        console.error(err.message);
        pool.end();
    }
}
run();
