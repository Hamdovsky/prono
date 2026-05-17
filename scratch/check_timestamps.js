const db = require('../core/database').db;
const matches = db.prepare('SELECT id, timestamp, homeTeam, awayTeam FROM matches LIMIT 50').all();
console.log(JSON.stringify(matches, null, 2));
