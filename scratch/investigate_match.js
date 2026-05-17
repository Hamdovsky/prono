const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join('C:', 'Users', 'HAMDI', 'Desktop', 'HamdiProno', 'stitch', 'data', 'tactical.db');
const db = new sqlite3.Database(dbPath);

const homeTeam = 'Liaoning Tieren%';
const awayTeam = 'Chengdu%';

db.all(
    `SELECT homeTeam, awayTeam, prediction, btts_prob, expected_score FROM matches WHERE homeTeam LIKE ? AND awayTeam LIKE ? ORDER BY startTimestamp DESC LIMIT 1`,
    [homeTeam, awayTeam],
    (err, rows) => {
        if (err) {
            console.error('❌ Error querying matches:', err);
        } else {
            console.log('✅ Matches found:');
            console.log(JSON.stringify(rows, null, 2));
        }
        db.close();
    }
);
