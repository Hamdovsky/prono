const database = require('./database');
const EnrichedPredictionService = require('./enriched_predictions');
const logger = require('./logger');

async function reEnrich() {
    console.log('🚀 [RE-ENRICH] Starting mass prediction update...');
    const service = EnrichedPredictionService;
    
    try {
        // 1. Fetch matches with risk labels instead of picks
        // We target matches where prediction is a risk label or empty
        const riskLabels = ['SAFE', 'STABLE', 'MODERATE', 'RISKY', 'RISKY BET', ''];
        const allMatches = await database.getAllMatches();
        const matches = allMatches.filter(m => 
            riskLabels.includes(m.prediction) || !m.prediction
        );

        console.log(`📦 Found ${matches.length} matches needing update.`);

        let updatedCount = 0;
        let errorCount = 0;

        for (const match of matches) {
            try {
                // We use fastEnrichMatch to avoid calling Python for thousands of matches
                const enriched = await service.fastEnrichMatch(match);
                
                if (enriched && enriched.prediction) {
                    await database.updatePredictions(match.id, {
                        prediction: enriched.prediction,
                        verdict: enriched.verdict,
                        confidence: enriched.confidence,
                        expected_score: enriched.expected_score,
                        home_win_probability: enriched.home_win_probability,
                        draw_probability: enriched.draw_probability,
                        away_win_probability: enriched.away_win_probability,
                        ou_25_prob: enriched.ou_25_prob,
                        btts_prob: enriched.btts_prob,
                        enriched: enriched
                    });
                    updatedCount++;
                }
            } catch (err) {
                errorCount++;
                // console.error(`❌ Error updating match ${match.id}: ${err.message}`);
            }
        }

        console.log(`✅ [RE-ENRICH] Completed!`);
        console.log(`- Updated: ${updatedCount}`);
        console.log(`- Errors: ${errorCount}`);
        console.log(`- Total processed: ${matches.length}`);

    } catch (globalErr) {
        console.error(`💥 [RE-ENRICH] Critical Error: ${globalErr.message}`);
    } finally {
        process.exit(0);
    }
}

reEnrich();
