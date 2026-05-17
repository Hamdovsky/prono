const database = require('./database');
const enrichedPredictions = require('./enriched_predictions');

async function test() {
    const matches = await database.getMatchesByStatus('scheduled');
    const m = matches.find(m => m.expected_score === '3 - 0') || matches[0];
    if (!m) return;
    
    console.log(`Testing match: ${m.homeTeam} vs ${m.awayTeam}`);
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

    const fs = require('fs');
    fs.writeFileSync('/tmp/test_match_full.json', JSON.stringify(matchWithHistory, null, 2));

    const enriched = await enrichedPredictions.getAnalyticalPrediction(matchWithHistory);
    console.log(JSON.stringify(enriched, null, 2));
}

test();
