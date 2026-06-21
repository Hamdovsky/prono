const Database = require('better-sqlite3');
const expertEngine = require('./services/expertEngine');
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(__dirname, 'data', 'tactical.db');
const db = new Database(dbPath, { readonly: true });

const matches = db.prepare('SELECT id, homeTeam, awayTeam, status, fullData, last_updated FROM matches ORDER BY last_updated DESC LIMIT 100').all();

let eliteTargets = [];
let count = 0;

matches.forEach(row => {
    const date = new Date(row.last_updated);
    if (date.getDate() === 24 && date.getMonth() === 1) { // 1 is Feb
        try {
            const data = JSON.parse(row.fullData);
            let parsedStats = {};
            if (data.stats && Array.isArray(data.stats)) {
                const findStat = (name) => {
                    const s = data.stats.find(x => x.category.toLowerCase().includes(name.toLowerCase()));
                    if (!s) return { home: 0, away: 0 };
                    return { home: parseInt(s.homeValue), away: parseInt(s.awayValue) };
                };
                parsedStats = {
                    dangerousAttacks: findStat('Attacks') || { home: 0, away: 0 },
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
                hasDeepStats: !!data.stats
            };

            const result = expertEngine.getMatchIntelligence(matchInput);

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
        } catch (e) { }
    }
});

eliteTargets.sort((a, b) => b.prob - a.prob);

const output = {
    message: "🔥 TN-INTEL: ELITE PRONOSTIC - 24 FEVRIER 🔥",
    processedCount: count,
    targets: eliteTargets
};

fs.writeFileSync('elite_results.json', JSON.stringify(output, null, 2));

db.close();
