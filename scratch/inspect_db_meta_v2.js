const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');

const histInfo = db.prepare("PRAGMA table_info(historical_matches)").all();
console.log("historical_matches columns:", histInfo.map(c => c.name));

const predHistInfo = db.prepare("PRAGMA table_info(prediction_history)").all();
console.log("prediction_history columns:", predHistInfo.map(c => c.name));

db.close();
