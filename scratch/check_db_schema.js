const sqlite3 = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(process.cwd(), 'data', 'historical_archive.sqlite');
const db = new sqlite3(dbPath);

console.log('--- TABLE SCHEMA ---');
console.log(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='archive_matches'").get().sql);

console.log('\n--- INDICES ---');
const indices = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='archive_matches'").all();
indices.forEach(idx => console.log(idx.sql));

db.close();
