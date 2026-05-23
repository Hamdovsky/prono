const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../data/tactical.db');
const db = new Database(dbPath);

const match = db.prepare(`
    SELECT * 
    FROM matches 
    WHERE (homeTeam LIKE '%Draih%' OR homeTeam LIKE '%Diriyah%' OR homeTeam LIKE '%Jabalain%' OR homeTeam LIKE '%Jabal%')
       OR (awayTeam LIKE '%Draih%' OR awayTeam LIKE '%Diriyah%' OR awayTeam LIKE '%Jabalain%' OR awayTeam LIKE '%Jabal%')
    ORDER BY timestamp DESC
    LIMIT 5
`).all();

if (match && match.length > 0) {
    console.log("=== Matchs trouvés ===");
    match.forEach(m => {
        console.log(`\nMatch : ${m.homeTeam} vs ${m.awayTeam}`);
        console.log(`Ligue : ${m.league}`);
        console.log(`Statut : ${m.status}`);
        console.log(`Probabilité 1 (Domicile) : ${(m.home_win_probability || 0).toFixed(1)}%`);
        console.log(`Probabilité X (Nul) : ${(m.draw_probability || 0).toFixed(1)}%`);
        console.log(`Probabilité 2 (Extérieur) : ${(m.away_win_probability || 0).toFixed(1)}%`);
        console.log(`Over 2.5 Buts Prob : ${(m.ou_25_prob || 0).toFixed(1)}%`);
        
        const h = parseFloat(m.home_win_probability || 0);
        const a = parseFloat(m.away_win_probability || 0);
        const d = parseFloat(m.draw_probability || 0);
        
        let prono = "1";
        if (a > h && a > d) prono = "2";
        else if (d > h && d > a) prono = "X";
        
        console.log(`👉 Pronostic Final de l'IA : ${prono}`);
    });
} else {
    console.log("Match non trouvé dans la base de données locale.");
}
