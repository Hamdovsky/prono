const Database = require('better-sqlite3');
const expertEngine = require('./services/expertEngine');
const path = require('path');

const dbPath = path.resolve(__dirname, 'data', 'tactical.db');
const db = new Database(dbPath, { readonly: true });

// Check February 24th (Unix epochs)
// 24 Feb 2026 00:00 UTC ~ 1771804800000
// We'll just fetch recent matches from the last 48 hours for safety and filter if needed, 
// or let's just fetch everything and process matches with fullData.

console.log("\n=======================================================");
console.log("🔥 TN-INTEL: ELITE PRONOSTIC - 24 FEVRIER 🔥");
console.log("=======================================================\n");

const matches = db.prepare('SELECT id, homeTeam, awayTeam, status, fullData, last_updated FROM matches ORDER BY last_updated DESC LIMIT 100').all();

let count = 0;
let eliteTargets = [];

matches.forEach(row => {
    // Check if it's from around Feb 24
    const date = new Date(row.last_updated);
    if (date.getDate() === 24 && date.getMonth() === 1) {

        try {
            const data = JSON.parse(row.fullData);

            // Format for engine
            // The engine expects: homeTeam, awayTeam, minute, status, stats: { dangerousAttacks, possession, totalShots... }

            // Reconstruct stats object if it exists (the new scraper format or older)
            let parsedStats = {};
            if (data.stats && Array.isArray(data.stats)) {
                // Map Flashscore stats to engine stats
                const findStat = (name) => {
                    const s = data.stats.find(x => x.category.toLowerCase().includes(name.toLowerCase()));
                    if (!s) return { home: 0, away: 0 };
                    return { home: parseInt(s.homeValue), away: parseInt(s.awayValue) };
                };

                parsedStats = {
                    dangerousAttacks: findStat('Attacks') || { home: 0, away: 0 }, // Fallback
                    possession: findStat('possession'),
                    totalShots: findStat('shots'),
                    corners: findStat('corner')
                };
            }

            const matchInput = {
                id: row.id,
                homeTeam: row.homeTeam,
                awayTeam: row.awayTeam,
                league: data.league || "Unknown",
                minute: row.status === 'live' ? "live" : row.status,
                status: row.status,
                score: data.score || { home: 0, away: 0 },
                stats: parsedStats,
                hasDeepStats: data.stats ? true : false
            };

            const result = expertEngine.getMatchIntelligence(matchInput);

            // We only care about high confidence or elite for the pronostic
            if (result.winProb >= 60 || result.tacticalLabels.includes("ELITE_TARGET")) {
                eliteTargets.push({
                    match: `${row.homeTeam} vs ${row.awayTeam}`,
                    status: row.status,
                    pred: result.prediction,
                    prob: result.winProb,
                    labels: result.tacticalLabels.join(', ')
                });
            }
            count++;
        } catch (e) {
            // ignore parse errors
        }
    }
});

if (eliteTargets.length === 0) {
    console.log("❌ Aucun match 'Elite' n'a été trouvé pour le 24 Février avec des données statistiques suffisantes.");
    // Fallback: Show all parsed matches for the date
    console.log("\nRecherche de tous les matchs du 24 Février traités :");
    matches.forEach(row => {
        const date = new Date(row.last_updated);
        if (date.getDate() === 24 && date.getMonth() === 1) {
            const data = JSON.parse(row.fullData);
            console.log(`- ${row.homeTeam} vs ${row.awayTeam} [${row.status}]`);
        }
    });

} else {
    console.log("✅ ANOMALIES TACTIQUES DÉTECTÉES (ELITE PRONOSTIC):\n");
    eliteTargets.sort((a, b) => b.prob - a.prob).forEach((t, i) => {
        console.log(`[${i + 1}] ${t.match} (${t.status})`);
        console.log(`    🎯 Pronostic : ${t.pred}`);
        console.log(`    📊 Confiance : ${t.prob}%`);
        console.log(`    🏷️  Tags      : ${t.labels}\n`);
    });
}

console.log(`\n(Moteur exécuté sur ${count} matchs récupérés le 24 Février)`);
console.log("=======================================================\n");

db.close();
