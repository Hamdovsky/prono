const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/tactical.db');
const db = new Database(dbPath);

// Today is May 18, 2026 (local time is GMT+1)
const startOfToday = new Date('2026-05-18T00:00:00+01:00').getTime();
const endOfToday = new Date('2026-05-18T23:59:59+01:00').getTime();

const matches = db.prepare(`
    SELECT homeTeam, awayTeam, league, status, startTimestamp, 
           home_win_probability, draw_probability, away_win_probability, 
           xgboost_confidence, prediction, confidence, fullData
    FROM matches
    WHERE status IN ('scheduled', 'NOT_STARTED', 'NS', 'upcoming')
`).all();

const todayMatches = matches.filter(m => {
    let ts = m.startTimestamp ? (m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000) : 0;
    return ts >= startOfToday && ts <= endOfToday;
});

const safeMatches = todayMatches.map(m => {
    const h = parseFloat(m.home_win_probability || 0);
    const a = parseFloat(m.away_win_probability || 0);
    const d = parseFloat(m.draw_probability || 0);
    const xgb = parseFloat(m.xgboost_confidence || 0);
    const baseConf = Math.max(h, a);
    const totalConf = baseConf + (xgb * 15);
    
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
}).filter(m => m.baseConf >= 60) // Slightly lower threshold for today to ensure we find matches if 65 is too strict
  .sort((a, b) => b.titaniumConf - a.titaniumConf)
  .slice(0, 10);

console.log("=========================================");
console.log("🛡️ MATCHS SÛRS POUR AUJOURD'HUI (18 MAI 2026) 🛡️");
console.log("=========================================\n");

if (safeMatches.length === 0) {
    console.log("Aucun match sûr trouvé pour aujourd'hui (probabilité >= 60%).");
    console.log(`Nombre total de matchs aujourd'hui en base : ${todayMatches.length}`);
} else {
    safeMatches.forEach((m, i) => {
        console.log(`${i+1}. ${m.homeTeam} vs ${m.awayTeam}`);
        console.log(`   🏆 Ligue: ${m.league || 'Inconnue'}`);
        console.log(`   ⏰ Date: ${m.startTime}`);
        console.log(`   👉 Pronostic: ${m.prono} (Base: ${m.baseConf.toFixed(1)}%, Global: ${m.titaniumConf.toFixed(1)}/100)`);
        console.log(`   📊 Détails: 1 (${(m.home_win_probability||0).toFixed(1)}%) | X (${(m.draw_probability||0).toFixed(1)}%) | 2 (${(m.away_win_probability||0).toFixed(1)}%)\n`);
    });
}
