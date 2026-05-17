const Database = require('better-sqlite3');
const db = new Database('./data/historical_archive.sqlite');
const info = db.prepare('PRAGMA table_info(archive_matches)').all();
console.log("COLUMNS:");
info.forEach(c => console.log(`- ${c.name}`));
db.close();
