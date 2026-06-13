const database = require('../core/database');
const enrichedPredictions = require('../core/enriched_predictions');

async function forceEnrichAll() {
    console.log('🚀 Starting TOTAL FORCE RE-ENRICHMENT (V4 - Dixon-Coles + Gamma fix)...');
    
    const matches = await database.getMatchesByStatus('scheduled');
    console.log(`📊 Found ${matches.length} matches to re-analyze.`);

    // Use fast JS path (no Python, no timeout)
    const enriched = await enrichedPredictions.enrichMatches(matches, { fastMode: true, force: true });

    let updated = 0;
    let varied = 0;
    for (const m of enriched) {
        if (m.expected_score) {
            await database.updatePredictions(m.id, m);
            updated++;
            if (m.expected_score !== '1 - 1') varied++;
        }
    }

    console.log(`\n✨ FINAL REPORT:`);
    console.log(`- Total Processed: ${updated}`);
    console.log(`- Non-1-1 Scores: ${varied}`);
    console.log(`- Completion Time: ${new Date().toISOString()}`);

    // Show first 5 scores
    for (let i = 0; i < Math.min(5, enriched.length); i++) {
        const m = enriched[i];
        if (m.expected_score) {
            console.log(`  ${m.homeTeam} vs ${m.awayTeam}: ${m.expected_score} (${Math.round(m.home_win_probability || 0)}%)`);
        }
    }

    process.exit(0);
}

forceEnrichAll();
