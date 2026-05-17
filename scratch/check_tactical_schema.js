const sqlite3 = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(process.cwd(), 'data', 'tactical.db');
const db = new sqlite3(dbPath);

console.log('--- TABLE SCHEMA (matches) ---');
const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='matches'").get();
console.log(schema ? schema.sql : 'Table not found');

db.close();
