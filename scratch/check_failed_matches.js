const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');

function isPredictionCorrect(prediction, scoreH, scoreA) {
    if (scoreH === null || scoreA === null) return false;
    const pred = (prediction || '').toLowerCase();
    
    if (pred.includes('home') || pred === '1') return scoreH > scoreA;
    if (pred.includes('away') || pred === '2') return scoreA > scoreH;
    if (pred.includes('draw') || pred === 'x') return scoreH === scoreA;
    
    return false; // Default to fail if unknown
}

const matches = db.prepare(`
    SELECT homeTeam, awayTeam, scoreHome, scoreAway, prediction, tournament_name 
    FROM matches 
    WHERE status IN ('FINISHED', 'FT', 'Ended') 
    AND scoreHome IS NOT NULL 
    AND datetime(timestamp, 'unixepoch') >= date('now')
`).all();

const failed = matches.filter(m => !isPredictionCorrect(m.prediction, m.scoreHome, m.scoreAway));

console.log('Total finished today:', matches.length);
console.log('Total failed today:', failed.length);
console.log('Failed Matches:');
failed.forEach(m => {
    console.log(`- ${m.homeTeam} vs ${m.awayTeam} | Pred: ${m.prediction} | Score: ${m.scoreHome}-${m.scoreAway} | (${m.tournament_name})`);
});

db.close();
