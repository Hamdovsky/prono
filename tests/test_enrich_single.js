const database = require('./database');
const enrichedPredictions = require('./enriched_predictions');

async function testSingleEnrich() {
    try {
        const matches = await database.getMatchesByStatus('scheduled');
        const m = matches.find(x => x.expected_score === '3 - 0') || matches[0];
        
        console.log(`Re-enriching: ${m.homeTeam} vs ${m.awayTeam}`);
        
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

        const enriched = await enrichedPredictions.enrichMatch(matchWithHistory);
        const fs = require('fs');
        fs.writeFileSync('/tmp/python_res.json', JSON.stringify(enriched, null, 2));
        console.log("Details dumped to /tmp/python_res.json");
    } catch (e) {
        const fs = require('fs');
        fs.writeFileSync('/tmp/err.log', e.stack);
        console.log("Error written to /tmp/err.log");
    }
}
testSingleEnrich();
