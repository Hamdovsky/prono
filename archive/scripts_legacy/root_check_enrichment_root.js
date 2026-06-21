const database = require('./core/database');

async function check() {
    const matches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']);
    console.log(`Total upcoming matches: ${matches.length}`);
    const enriched = matches.filter(m => m.home_win_probability && m.home_win_probability > 0);
    console.log(`Enriched matches: ${enriched.length}`);
    if (enriched.length > 0) {
        console.log('Sample enriched matches (first 5):');
        for (let i = 0; i < Math.min(5, enriched.length); i++) {
            const m = enriched[i];
            console.log({
                id: m.id,
                home: m.homeTeam,
                away: m.awayTeam,
                hProb: m.home_win_probability,
                es: m.expected_score
            });
        }
    }
}

check().catch(console.error);
