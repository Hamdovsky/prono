const database = require('../core/database');
const enrichedPredictions = require('../core/enriched_predictions');

async function testApi() {
    try {
        const allMatches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']);
        let rawMatches = allMatches;
        
        const nowTs = Date.now();
        const startOfToday = new Date().setHours(0, 0, 0, 0);
        const endOfRange = startOfToday + (48 * 60 * 60 * 1000); 
        
        console.log(`Now: ${new Date(nowTs).toISOString()}`);
        console.log(`Range: ${new Date(startOfToday).toISOString()} to ${new Date(endOfRange).toISOString()}`);

        const filteredByDate = rawMatches.filter(m => {
            let tsMs = m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000;
            return tsMs >= (nowTs - 7200000) && tsMs <= endOfRange;
        });

        console.log(`Filtered by date: ${filteredByDate.length}`);
        
        // Quality Gate check
        const RESERVE_RE = /\b(II|III|IV|B|C|U\d{2}|U-\d{2}|Reserves?|Youth|Academy|Reserve|Filial|Amateurs?|Dev(elopment)?|Juniors?)\b/i;
        const final = filteredByDate.filter(m => {
            const home = m.homeTeam || '';
            const away = m.awayTeam || '';
            if (RESERVE_RE.test(home) || RESERVE_RE.test(away)) return false;
            return true;
        });

        console.log(`Final after quality gate: ${final.length}`);
        if (final.length > 0) {
            console.log("Sample matches:");
            final.slice(0, 5).forEach(m => console.log(`  ${m.homeTeam} vs ${m.awayTeam} | ${new Date(m.startTimestamp*1000).toISOString()}`));
        }
    } catch (e) {
        console.error(e);
    }
}

testApi();
