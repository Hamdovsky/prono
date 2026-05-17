const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Matrix22!', host: 'localhost', port: 5432, database: 'postgres' });

async function run() {
    try {
        const res = await pool.query("SELECT id, fulldata FROM matches WHERE fulldata->>'h2h_data' IS NOT NULL LIMIT 5");
        console.log(`🔍 Found ${res.rows.length} matches with H2H data.`);
        res.rows.forEach(r => {
            const h2h = r.fulldata.h2h_data;
            console.log(`   Match ${r.id}: H2H [${h2h.teamDuel?.homeWins}-${h2h.teamDuel?.draws}-${h2h.teamDuel?.awayWins}]`);
        });
        pool.end();
    } catch (err) {
        console.error(err.message);
        pool.end();
    }
}
run();
