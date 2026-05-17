const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');

function isPredictionCorrect(prediction, scoreH, scoreA) {
    if (scoreH === null || scoreA === null) return false;
    const pred = (prediction || '').toLowerCase();
    if (pred === 'no bet' || pred === '') return false;
    
    if (pred.includes('home') || pred === '1') return scoreH > scoreA;
    if (pred.includes('away') || pred === '2') return scoreA > scoreH;
    if (pred.includes('draw') || pred === 'x') return scoreH === scoreA;
    
    return false;
}

const matches = db.prepare(`
    SELECT homeTeam, awayTeam, scoreHome, scoreAway, prediction, tournament_name, datetime(timestamp, 'unixepoch') as date
    FROM matches 
    WHERE status = 'finished'
    AND scoreHome IS NOT NULL 
    AND prediction IS NOT NULL 
    AND prediction != 'NO BET'
    ORDER BY timestamp DESC LIMIT 30
`).all();

console.log('Failed predictions with analysis:');
matches.forEach(m => {
    const correct = isPredictionCorrect(m.prediction, m.scoreHome, m.scoreAway);
    if (!correct) {
        console.log(`❌ ${m.homeTeam} vs ${m.awayTeam} | Pred: ${m.prediction} | Score: ${m.scoreHome}-${m.scoreAway} | (${m.tournament_name})`);
    }
});

db.close();
