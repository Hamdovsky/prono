const database = require('./database');
const enrichedPredictions = require('./enriched_predictions');

async function testSingleMatch(matchId) {
    console.log(`🔍 Testing enrichment for match ID: ${matchId}`);
    try {
        const match = await database.getMatchById(matchId);
        if (!match) {
            console.error('❌ Match not found in database.');
            return;
        }

        console.log(`📋 Match: ${match.homeTeam} vs ${match.awayTeam}`);
        
        const [h_history, a_history, lg_avg] = await Promise.all([
            database.getTeamMatchHistory(match.homeTeam, 5),
            database.getTeamMatchHistory(match.awayTeam, 5),
            database.getLeagueAverages(match.league)
        ]);

        const matchWithHistory = {
            ...match,
            history_home: h_history,
            history_away: a_history,
            league_averages: lg_avg
        };

        const enriched = await enrichedPredictions.enrichMatch(matchWithHistory);
        console.log('✨ Enrichment Result:', JSON.stringify(enriched, null, 2));

        const data = {
            home_win_probability: enriched.home_win_probability || 0,
            draw_probability: enriched.draw_probability || 0,
            away_win_probability: enriched.away_win_probability || 0,
            expected_score: enriched.expected_score || '? - ?',
            xgboost_confidence: enriched.xgboost_confidence || 0,
            insufficient_data: enriched.insufficient_data ? 1 : 0
        };

        console.log('💾 Data to save:', data);
        
        await database.updatePredictions(matchId, data);
        console.log('✅ Update successful.');

    } catch (e) {
        console.error('❌ Error during test:', e);
    }
}

const matchId = process.argv[2] || '15631363';
testSingleMatch(matchId).then(() => process.exit(0));
