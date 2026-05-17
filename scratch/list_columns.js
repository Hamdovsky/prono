const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join('C:', 'Users', 'HAMDI', 'Desktop', 'HamdiProno', 'stitch', 'data', 'tactical.db');
const db = new sqlite3.Database(dbPath);

db.all(`PRAGMA table_info(matches)`, (err, rows) => {
    if (err) {
        console.error('❌ Error getting table info:', err);
    } else {
        console.log('✅ Columns in matches table:');
        console.log(rows.map(r => r.name).join(', '));
    }
    db.close();
});
