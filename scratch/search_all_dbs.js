const Database = require('better-sqlite3');
const dbs = ['data/tactical.db', 'stitch_main.db', 'database.sqlite', 'app.db', 'live_system.db'];

dbs.forEach(dbPath => {
    try {
        const db = new Database(dbPath);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        console.log(`DB: ${dbPath} | TABLES: ${tables.map(t => t.name).join(', ')}`);
        
        tables.forEach(table => {
            const row = db.prepare(`SELECT * FROM ${table.name} WHERE (homeTeam LIKE '%Falkenberg%' OR awayTeam LIKE '%Falkenberg%') LIMIT 1`).all();
            if (row.length > 0) {
                console.log(`MATCH FOUND in DB: ${dbPath}, TABLE: ${table.name}`);
                console.log(JSON.stringify(row[0], null, 2));
            }
        });
        db.close();
    } catch (e) {
        // console.error(`Error with ${dbPath}: ${e.message}`);
    }
});
