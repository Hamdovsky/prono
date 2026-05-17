const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Matrix22!', host: 'localhost', port: 5432, database: 'postgres' });

async function run() {
    try {
        const res = await pool.query("SELECT id FROM matches LIMIT 1");
        if (res.rows.length > 0) {
            const id = res.rows[0].id;
            console.log("Match ID:", id);
            console.log("Type of ID:", typeof id);
        }
        pool.end();
    } catch (err) {
        console.error(err.message);
        pool.end();
    }
}
run();
