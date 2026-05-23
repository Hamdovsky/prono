const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/tactical.db');
const db = new Database(dbPath);

const startOfToday = new Date('2026-05-18T00:00:00+01:00').getTime();
const endOfToday = new Date('2026-05-18T23:59:59+01:00').getTime();

const matches = db.prepare(`
    SELECT homeTeam, awayTeam, league, status, startTimestamp, 
           home_win_probability, draw_probability, away_win_probability, 
           xgboost_confidence, prediction, confidence, fullData
    FROM matches
    WHERE status != 'finished'
`).all();

const todayMatches = matches.filter(m => {
    let ts = m.startTimestamp ? (m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000) : 0;
    // We also include matches that are missing a timestamp just in case
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
}).filter(m => m.baseConf > 0) 
  .sort((a, b) => b.titaniumConf - a.titaniumConf)
  .slice(0, 10);

console.log("=========================================");
console.log("🛡️ TOP 10 MATCHS POUR AUJOURD'HUI (18 MAI) 🛡️");
console.log("=========================================\n");

safeMatches.forEach((m, i) => {
    console.log(`${i+1}. ${m.homeTeam} vs ${m.awayTeam}`);
    console.log(`   🏆 Ligue: ${m.league || 'Inconnue'}`);
    console.log(`   ⏰ Date: ${m.startTime}`);
    console.log(`   👉 Pronostic: ${m.prono} (Confiance: ${m.baseConf.toFixed(1)}%)`);
    console.log(`   📊 Détails: 1 (${(m.home_win_probability||0).toFixed(1)}%) | X (${(m.draw_probability||0).toFixed(1)}%) | 2 (${(m.away_win_probability||0).toFixed(1)}%)\n`);
});

if (safeMatches.length === 0) {
    console.log("Aucun match trouvé pour aujourd'hui. Elargissement de la recherche pour demain (19 Mai)...");
    
    const startOfTmrw = new Date('2026-05-19T00:00:00+01:00').getTime();
    const endOfTmrw = new Date('2026-05-19T23:59:59+01:00').getTime();
    
    const tmrwMatches = matches.filter(m => {
        let ts = m.startTimestamp ? (m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000) : 0;
        return ts >= startOfTmrw && ts <= endOfTmrw;
    });

    const tmrwSafe = tmrwMatches.map(m => {
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
    }).filter(m => m.baseConf > 0) 
      .sort((a, b) => b.titaniumConf - a.titaniumConf)
      .slice(0, 10);
      
    tmrwSafe.forEach((m, i) => {
        console.log(`${i+1}. ${m.homeTeam} vs ${m.awayTeam}`);
        console.log(`   🏆 Ligue: ${m.league || 'Inconnue'}`);
        console.log(`   ⏰ Date: ${m.startTime}`);
        console.log(`   👉 Pronostic: ${m.prono} (Confiance: ${m.baseConf.toFixed(1)}%)`);
        console.log(`   📊 Détails: 1 (${(m.home_win_probability||0).toFixed(1)}%) | X (${(m.draw_probability||0).toFixed(1)}%) | 2 (${(m.away_win_probability||0).toFixed(1)}%)\n`);
    });
}
