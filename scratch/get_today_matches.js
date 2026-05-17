const db = require('../core/database').db;
const matches = db.prepare(`
    SELECT homeTeam, awayTeam, league, prediction, confidence, odds_home, odds_draw, odds_away, timestamp 
    FROM matches 
    WHERE timestamp LIKE '2026-04-19%'
`).all();

const bestMatches = matches.filter(m => {
    const odds = [m.odds_home, m.odds_draw, m.odds_away].filter(o => o !== null);
    // For simplicity, if prediction is home, check odds_home, etc.
    // But since prediction values can be diverse, let's just find matches where ANY odd >= 1.7 
    // and the prediction aligns (if possible to determine).
    // Most predictions are 'H', 'A', 'D' or similar in some systems, 
    // but here I see 'RISKY BET', 'STRONG BET'.
    
    // Let's assume the user wants 6 matches where we have a prediction and the odds are good.
    return (m.odds_home >= 1.7 || m.odds_away >= 1.7 || m.odds_draw >= 1.7);
}).sort((a, b) => b.confidence - a.confidence);

console.log(JSON.stringify(bestMatches.slice(0, 10), null, 2));
