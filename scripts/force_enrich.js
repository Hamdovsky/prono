const database = require('../core/database');
const enrichedPredictions = require('../core/enriched_predictions');

async function forceEnrichAll() {
    console.log('🚀 Starting TOTAL FORCE RE-ENRICHMENT (V3 - Variance Fix)...');
    
    // 1. Get all scheduled matches
    const matches = await database.getMatchesByStatus('scheduled');
    console.log(`📊 Found ${matches.length} matches to re-analyze.`);

    let count = 0;
    let varied = 0;

    // 2. Process in batches
    for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        try {
            // Fetch history and league context to feed the logic
            const [h_history, a_history, lg_avg] = await Promise.all([
                database.getTeamMatchHistory(m.homeTeam, 5),
                database.getTeamMatchHistory(m.awayTeam, 5),
                database.getLeagueAverages(m.league)
            ]);

            const matchWithHistory = {
                ...m,
                history_home: h_history,
                history_away: a_history,
                league_averages: lg_avg
            };

            // This calls the Python engine which now has the Rounded Mean logic
            const enriched = await enrichedPredictions.enrichMatch(matchWithHistory);

            const data = {
                home_win_probability: enriched.home_win_probability || 0,
                draw_probability: enriched.draw_probability || 0,
                away_win_probability: enriched.away_win_probability || 0,
                expected_score: enriched.expected_score || '? - ?',
                chaos_score: enriched.chaos_score || 50,
                ou_25_prob: enriched.ou_25_prob || 0,
                btts_prob: enriched.btts_prob || 0,
                xgboost_confidence: enriched.xgboost_confidence || 0,
                xgboost_prediction_data: JSON.stringify(enriched.xgboost_prediction_data || {}),
                insufficient_data: enriched.insufficient_data ? 1 : 0,
                news_data: enriched.news_data ? (typeof enriched.news_data === 'string' ? enriched.news_data : JSON.stringify(enriched.news_data)) : null
            };

            await database.updatePredictions(m.id, data);
            
            if (count === 0) {
                console.log('🔍 [FULL DEBUG] First Enriched Object:', JSON.stringify(enriched, null, 2));
            }

            if (count < 20) {
                console.log(`🔍 [DEBUG] ${m.homeTeam} vs ${m.awayTeam}: ${data.expected_score} (H-Prob: ${data.home_win_probability}%)`);
            }

            if (data.expected_score !== '1 - 1' && data.expected_score !== '? - ?') {
                varied++;
            }
            
            count++;
            if (count % 20 === 0) {
                console.log(`✅ Processed ${count}/${matches.length} matches... (Varied: ${varied})`);
            }
        } catch (e) {
            console.error(`❌ Error on match ${m.id}: ${e.message}`);
        }
    }

    console.log(`\n✨ FINAL REPORT:`);
    console.log(`- Total Processed: ${count}`);
    console.log(`- Non-1-1 Scores: ${varied}`);
    console.log(`- Completion Time: ${new Date().toISOString()}`);
    process.exit(0);
}

forceEnrichAll();
