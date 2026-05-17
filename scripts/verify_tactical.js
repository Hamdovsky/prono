const Database = require('better-sqlite3');
const db = new Database('c:/Users/HAMDI/Desktop/stitch/data/tactical.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables in tactical.db:', tables.map(t => t.name).join(', '));
const schema = db.prepare("PRAGMA table_info(player_props_predictions)").all();
console.log('Schema for player_props_predictions:', schema);
