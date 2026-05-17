const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');

function isPredictionCorrect(prediction, scoreH, scoreA) {
    if (scoreH === null || scoreA === null) return false;
    const pred = (prediction || '').toLowerCase();
    
    if (pred.includes('home') || pred === '1') return scoreH > scoreA;
    if (pred.includes('away') || pred === '2') return scoreA > scoreH;
    if (pred.includes('draw') || pred === 'x') return scoreH === scoreA;
    
    return false;
}

const matches = db.prepare(`
    SELECT id, homeTeam, awayTeam, scoreHome, scoreAway, prediction, tournament_name, datetime(timestamp, 'unixepoch') as date
    FROM matches 
    WHERE status = 'finished'
    AND scoreHome IS NOT NULL 
    ORDER BY timestamp DESC LIMIT 20
`).all();

console.log('Last 20 finished matches:');
matches.forEach(m => {
    const correct = isPredictionCorrect(m.prediction, m.scoreHome, m.scoreAway);
    console.log(`${correct ? '✅' : '❌'} ${m.homeTeam} vs ${m.awayTeam} | Pred: ${m.prediction} | Score: ${m.scoreHome}-${m.scoreAway} | Date: ${m.date}`);
});

db.close();
