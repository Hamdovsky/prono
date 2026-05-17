const DB = require('better-sqlite3');
const db = new DB('./data/tactical.db');
const fs = require('fs');
const { execSync } = require('child_process');

try {
    const row = db.prepare('SELECT id, homeTeam, awayTeam, fullData FROM matches WHERE expected_score = "3 - 0" LIMIT 1').get();
    if (row) {
        fs.writeFileSync('/tmp/test_match.json', row.fullData || '{}');
        console.log(`Testing match: ${row.homeTeam} vs ${row.awayTeam}`);
        const out = execSync('python prediction_engine.py < /tmp/test_match.json').toString();
        console.log(out);
    }
} catch (e) { console.error(e); }
