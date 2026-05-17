const { SofaAPI } = require('../SofascoreScraping/src/apiClient');
const { LEAGUES, LEAGUE_MAP } = require('../config/leagueRegistry');

async function test() {
    console.log("🧪 Testing Priority Tournament Sweep for PL2 (ID 1129)...");
    
    const fl = LEAGUE_MAP['ENG_PL2'];
    if (!fl) {
        console.error("❌ ENG_PL2 not found in registry!");
        return;
    }

    try {
        console.log(`📡 [FORCE] Syncing ${fl.displayName} (ID: ${fl.sofascoreId})...`);
        const seasonsRes = await SofaAPI.getTournamentSeasons(fl.sofascoreId);
        if (seasonsRes && seasonsRes.seasons && seasonsRes.seasons.length > 0) {
            const currentSeasonId = seasonsRes.seasons[0].id;
            console.log(`Season: ${seasonsRes.seasons[0].name} (ID: ${currentSeasonId})`);
            
            const nextRes = await SofaAPI.getTournamentEvents(fl.sofascoreId, currentSeasonId, 'next');
            const lastRes = await SofaAPI.getTournamentEvents(fl.sofascoreId, currentSeasonId, 'last');
            
            const events = [...(nextRes.events || []), ...(lastRes.events || [])];
            console.log(`✅ Found ${events.length} total events in tournament sweep.`);
            
            // Log today's matches
            const today = '2026-03-23';
            const todayMatches = events.filter(e => new Date(e.startTimestamp * 1000).toISOString().startsWith(today));
            console.log(`📅 Matches for ${today}: ${todayMatches.length}`);
            todayMatches.forEach(m => {
                console.log(`   - [${m.id}] ${m.homeTeam.name} vs ${m.awayTeam.name}`);
            });
        }
    } catch (e) {
        console.error("❌ Test failed:", e.message);
    }
}
test();
