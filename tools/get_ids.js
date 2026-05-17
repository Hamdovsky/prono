const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Matrix22!', host: 'localhost', port: 5432, database: 'postgres' });

async function run() {
    try {
        const res = await pool.query("SELECT id FROM matches WHERE status = 'scheduled' LIMIT 5");
        console.log("Scheduled Match IDs:", res.rows.map(r => r.id));
        pool.end();
    } catch (err) {
        console.error(err.message);
        pool.end();
    }
}
run();
