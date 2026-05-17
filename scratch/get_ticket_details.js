const Database  = require('better-sqlite3');
const path      = require('path');
const enrichedPredictions = require('../core/enriched_predictions');

const DB_PATH = path.resolve(__dirname, '../data/tactical.db');

async function main() {
    const db = new Database(DB_PATH, { readonly: true });
    
    const now = new Date();
    const str = now.toISOString().split('T')[0];
    const ts0 = Math.floor(new Date(str + 'T00:00:00Z').getTime() / 1000);
    const ts1 = ts0 + 86400;

    const matches = db.prepare(`
        SELECT * FROM matches
        WHERE (date(datetime(startTimestamp, 'unixepoch')) = ?
           OR startTimestamp BETWEEN ? AND ?)
        AND (status = 'scheduled' OR status IS NULL OR status = 'notstarted')
    `).all(str, ts0, ts1);

    console.log(`Found ${matches.length} matches for today.`);

    let enrichedList = [];
    for (const m of matches) {
        try {
            const enriched = await enrichedPredictions.fastEnrichMatch(m);
            if (enriched) {
                enrichedList.push({ match: m, enriched });
            }
        } catch(e) {
            // Ignore
        }
    }

    // Sort by confidence or xgboost_confidence or expected value
    enrichedList.sort((a, b) => {
        const confA = parseFloat(a.match.xgboost_confidence || a.enriched.confidence || 0);
        const confB = parseFloat(b.match.xgboost_confidence || b.enriched.confidence || 0);
        return confB - confA;
    });

    console.log("\nTop 15 Matches for Today by Confidence:");
    for (let i = 0; i < Math.min(15, enrichedList.length); i++) {
        const item = enrichedList[i];
        const m = item.match;
        const e = item.enriched;
        console.log(`\n#${i+1} Match: ${m.homeTeam} vs ${m.awayTeam}`);
        console.log(`League: ${m.league} | Time: ${new Date(m.startTimestamp * 1000).toISOString()}`);
        console.log(`Probs - Home: ${e.home_win_probability}%, Draw: ${e.draw_probability}%, Away: ${e.away_win_probability}%`);
        console.log(`Confidence: ${m.xgboost_confidence || e.confidence} | expected_score: ${e.expected_score}`);
        console.log(`Smart Pick: ${e.surgical_market || 'N/A'} | BTTS: ${e.btts_prob}% | Over 2.5: ${e.ou_25_prob}%`);
    }

    db.close();
}

main();
