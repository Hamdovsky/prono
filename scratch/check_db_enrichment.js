const database = require('../core/database');

async function main() {
    try {
        const matches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS', 'LIVE', 'IN_PROGRESS']);
        
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
        
        const todays = matches.filter(m => {
            let ts = m.startTimestamp ? m.startTimestamp * 1000 : (m.timestamp ? new Date(m.timestamp).getTime() : 0);
            return ts >= startOfDay && ts <= endOfDay;
        });

        const enriched = todays.filter(m => m.home_win_probability > 0 || m.xgboost_confidence > 0);
        
        console.log(`--- DB STATUS 18 APRIL ---`);
        console.log(`Total matches found: ${todays.length}`);
        console.log(`Already enriched: ${enriched.length}`);
        
        if (enriched.length > 0) {
            console.log(`Sample enriched: ${enriched[0].homeTeam} vs ${enriched[0].awayTeam}`);
        }
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

main();
