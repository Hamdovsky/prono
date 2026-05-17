const Database = require('better-sqlite3');
const db = new Database('data/tactical.db'); // Checking the main tactical DB first

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("Tables in tactical.db:", tables.map(t => t.name));

const archiveInfo = db.prepare("PRAGMA table_info(archive_matches)").all();
console.log("archive_matches columns:", archiveInfo.map(c => c.name));

const performanceInfo = db.prepare("PRAGMA table_info(performance_metrics)").all();
console.log("performance_metrics columns:", performanceInfo.map(c => c.name));

db.close();
