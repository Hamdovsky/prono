const enrichedPredictions = require('./enriched_predictions');
const database = require('./database');

async function test() {
    const matches = await database.getMatchesByStatus('scheduled');
    if (matches.length === 0) {
        console.log('No matches');
        return;
    }

    const match = matches[0];
    console.log(`Testing match: ${match.homeTeam} vs ${match.awayTeam}`);

    const result = await enrichedPredictions.getAnalyticalPrediction(match);
    console.log('Result from Python Engine:');
    console.log(JSON.stringify(result, null, 2));

    process.exit(0);
}

test();
