const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');

function isPredictionCorrect(prediction, scoreH, scoreA) {
    if (scoreH === null || scoreA === null) return false;
    const pred = (prediction || '').toLowerCase();
    if (pred === 'no bet' || pred === '') return false;
    
    // Check if it's a 1X2 prediction
    const hTeam = 'home'; // Generic for checking strings
    const aTeam = 'away';
    
    if (pred.includes('home') || pred === '1') return scoreH > scoreA;
    if (pred.includes('away') || pred === '2') return scoreA > scoreH;
    if (pred.includes('draw') || pred === 'x') return scoreH === scoreA;
    
    // Team name based check (simplified)
    return false;
}

// Fetch all finished matches from today
const matches = db.prepare(`
    SELECT homeTeam, awayTeam, scoreHome, scoreAway, prediction, tournament_name, xgboost_confidence
    FROM matches 
    WHERE status = 'finished'
    AND prediction IS NOT NULL 
    AND prediction != 'NO BET'
    AND datetime(timestamp, 'unixepoch') >= datetime('now', '-24 hours')
`).all();

const lostSmartPicks = matches.filter(m => {
    // A Smart Pick is correct if its primary prediction matches the winner
    const scoreH = parseInt(m.scoreHome);
    const scoreA = parseInt(m.scoreAway);
    const pred = m.prediction.toLowerCase();
    const hName = m.homeTeam.toLowerCase();
    const aName = m.awayTeam.toLowerCase();
    
    let isCorrect = false;
    if (pred.includes(hName) || pred.includes('home') || pred === '1') isCorrect = scoreH > scoreA;
    else if (pred.includes(aName) || pred.includes('away') || pred === '2') isCorrect = scoreA > scoreH;
    else if (pred.includes('draw') || pred === 'x') isCorrect = scoreH === scoreA;
    
    return !isCorrect;
});

console.log('--- LOST SMART PICKS TODAY ---');
if (lostSmartPicks.length === 0) {
    console.log('No lost Smart Picks found for today.');
} else {
    lostSmartPicks.forEach(m => {
        console.log(`❌ [${m.tournament_name}] ${m.homeTeam} ${m.scoreHome}-${m.scoreAway} ${m.awayTeam}`);
        console.log(`   Pred: ${m.prediction} | Confiance: ${Math.round(m.xgboost_confidence * 100)}%`);
    });
}

db.close();
