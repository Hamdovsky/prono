const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/tactical.db');
const db = new Database(dbPath);

const now = Date.now();
const future48h = now + (48 * 60 * 60 * 1000);

const matches = db.prepare(`
    SELECT id, homeTeam, awayTeam, league, status, startTimestamp, timestamp, 
           home_win_probability, draw_probability, away_win_probability, 
           xgboost_confidence, prediction, confidence, fullData
    FROM matches
    WHERE status IN ('scheduled', 'NOT_STARTED', 'NS', 'upcoming')
`).all();

const upcoming = matches.filter(m => {
    let ts = m.startTimestamp ? (m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000) : 0;
    if (ts === 0) return true; // Include if timestamp is unknown but status is scheduled
    return ts > now;
});

const safeMatches = upcoming.map(m => {
    const h = parseFloat(m.home_win_probability || 0);
    const a = parseFloat(m.away_win_probability || 0);
    const d = parseFloat(m.draw_probability || 0);
    const xgb = parseFloat(m.xgboost_confidence || 0);
    const baseConf = Math.max(h, a);
    const totalConf = baseConf + (xgb * 15); // Weighted confidence
    
    let prono = "1";
    if (a > h && a > d) prono = "2";
    else if (d > h && d > a) prono = "X";
    
    let startTime = "Unknown";
    if (m.startTimestamp) {
        const ts = m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000;
        startTime = new Date(ts).toLocaleString('fr-FR');
    }

    return {
        ...m,
        titaniumConf: totalConf,
        baseConf,
        prono,
        startTime
    };
}).filter(m => m.baseConf >= 65) // Only high confidence (>= 65%)
  .sort((a, b) => b.titaniumConf - a.titaniumConf)
  .slice(0, 10);

console.log("=========================================");
console.log("🛡️ TOP SAFE UPCOMING MATCHES 🛡️");
console.log("=========================================\n");

if (safeMatches.length === 0) {
    console.log("Aucun match sûr (probabilité >= 65%) trouvé dans les matchs programmés.");
} else {
    safeMatches.forEach((m, i) => {
        console.log(`${i+1}. ${m.homeTeam} vs ${m.awayTeam}`);
        console.log(`   🏆 Ligue: ${m.league}`);
        console.log(`   ⏰ Date: ${m.startTime}`);
        console.log(`   👉 Pronostic: ${m.prono} (Base: ${m.baseConf.toFixed(1)}%, Global: ${m.titaniumConf.toFixed(1)}/100)`);
        console.log(`   📊 Détails: 1 (${(m.home_win_probability||0).toFixed(1)}%) | X (${(m.draw_probability||0).toFixed(1)}%) | 2 (${(m.away_win_probability||0).toFixed(1)}%)\n`);
    });
}
