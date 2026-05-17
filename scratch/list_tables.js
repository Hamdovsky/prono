const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const databases = ['stitch_main.db', 'app.db', 'database.sqlite', 'live_system.db', 'tactical.db', 'titanium_tactical.db'];

databases.forEach(dbFile => {
    const dbPath = path.join('c:', 'Users', 'HAMDI', 'Desktop', 'HamdiProno', 'stitch', dbFile);
    const db = new sqlite3.Database(dbPath, (err) => {
        if (err) return;
        db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, rows) => {
            if (err) return;
            console.log(`Database: ${dbFile}`);
            console.log(rows.map(r => r.name));
            db.close();
        });
    });
});
