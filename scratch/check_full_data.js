const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');
const row = db.prepare('SELECT homeTeam, awayTeam, fullData FROM matches WHERE fullData IS NOT NULL LIMIT 1').get();
if (row && row.fullData) {
    try {
        const data = JSON.parse(row.fullData);
        console.log('Match:', row.homeTeam, 'vs', row.awayTeam);
        console.log('Keys in fullData:', Object.keys(data));
        if (data.cs_ai) console.log('CS AI:', data.cs_ai);
        if (data.tg_ou) console.log('TG OU:', data.tg_ou);
    } catch (e) {
        console.log('Not JSON');
    }
}
db.close();
