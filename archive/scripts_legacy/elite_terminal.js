const Database = require('better-sqlite3');
const expertEngine = require('./services/expertEngine');
const path = require('path');

const dbPath = path.resolve(__dirname, 'data', 'tactical.db');
const db = new Database(dbPath, { readonly: true });

console.log("\n=======================================================");
console.log("🔥 TN-INTEL: ELITE PRONOSTIC - 24 FEVRIER 🔥");
console.log("=======================================================\n");

const matches = db.prepare('SELECT id, homeTeam, awayTeam, status, fullData, last_updated FROM matches ORDER BY last_updated DESC LIMIT 300').all();

let count = 0;
let validMatches = [];

matches.forEach(row => {
    const date = new Date(row.last_updated);
    if (date.getDate() === 24 && date.getMonth() === 1) { // 1 is index for February
        try {
            const data = JSON.parse(row.fullData);
            let parsedStats = {};
            if (data.stats && Array.isArray(data.stats)) {
                const findStat = (name) => {
                    const s = data.stats.find(x => x.category.toLowerCase().includes(name.toLowerCase()));
                    if (!s) return { home: 0, away: 0 };
                    return { home: parseInt(s.homeValue) || 0, away: parseInt(s.awayValue) || 0 };
                };
                parsedStats = {
                    dangerousAttacks: findStat('Attacks'),
                    possession: findStat('possession'),
                    totalShots: findStat('shots'),
                    corners: findStat('corner')
                };
            } else {
                parsedStats = {
                    dangerousAttacks: { home: 0, away: 0 },
                    possession: { home: 0, away: 0 },
                    totalShots: { home: 0, away: 0 },
                    corners: { home: 0, away: 0 }
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
                hasDeepStats: !!data.stats
            };

            const result = expertEngine.getMatchIntelligence(matchInput);

            validMatches.push({
                match: `${row.homeTeam} vs ${row.awayTeam}`,
                status: row.status,
                pred: result.prediction || "DRAW/NO_DATA",
                prob: result.winProb || 0,
                labels: result.tacticalLabels && result.tacticalLabels.length > 0 ? result.tacticalLabels.join(', ') : 'STANDARD'
            });
            count++;
        } catch (e) { }
    }
});

// Sort by probability and get top 15
validMatches.sort((a, b) => b.prob - a.prob);
const elites = validMatches.slice(0, 15);

if (elites.length === 0) {
    console.log("❌ Aucun match traité pour le 24 Février.");
} else {
    console.log("✅ TOP 15 SÉLECTIONS TACTIQUES (ELITE PRONOSTIC):\n");
    elites.forEach((t, i) => {
        console.log(`[${i + 1}] ${t.match} (${t.status})`);
        console.log(`    🎯 Pronostic : ${t.pred}`);
        console.log(`    📊 Confiance : ${t.prob}%`);
        console.log(`    🏷️  Tags      : ${t.labels}\n`);
    });
}

console.log(`\n(Moteur exécuté sur ${count} matchs récupérés le 24 Février)`);
console.log("=======================================================\n");

db.close();
