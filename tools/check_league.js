const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', password: 'Matrix22!', host: 'localhost', port: 5432, database: 'postgres' });

async function run() {
    try {
        const res = await pool.query("SELECT id, hometeam, awayteam, league, status FROM matches WHERE league ILIKE '%Premier League 2%' OR (fulldata->>'league')::text ILIKE '%Premier League 2%' OR (fulldata->'tournament'->>'name')::text ILIKE '%Premier League 2%'");
        console.log(`Found ${res.rows.length} matches for Premier League 2.`);
        res.rows.forEach(r => {
            console.log(`- ID: ${r.id} | ${r.hometeam} vs ${r.awayteam} | League: ${r.league} | Status: ${r.status}`);
        });
        pool.end();
    } catch (err) {
        console.error(err.message);
        pool.end();
    }
}
run();
