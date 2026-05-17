const { SofaAPI } = require('../SofascoreScraping/src/apiClient');

async function test() {
    // Manchester City vs Real Madrid or similar known match ID
    // Let's get a recent match ID from live events
    const liveRes = await SofaAPI.getLiveEvents();
    const event = liveRes?.events?.[0];
    
    if (!event) {
        console.log("No live events found to test.");
        return;
    }
    const matchId = event.id;
    console.log(`Testing with Match ID: ${matchId}`);
    
    const { fetchWithRetry, BASE_HEADERS, getRandomUserAgent } = require('../SofascoreScraping/src/apiClient');
    
    // 1. Test Shotmap
    const shotmapUrl = `https://www.sofascore.com/api/v1/event/${matchId}/shotmap`;
    const res = await fetchWithRetry(shotmapUrl);
    if (res) {
        const data = await res.json();
        console.log("SHOTMAP:", data.shotmap ? `Found ${data.shotmap.length} shots` : data);
    }
    
    // 2. Test player heatmap (get first player from lineups)
    const lineups = await SofaAPI.getLineups(matchId);
    if (lineups && lineups.home && lineups.home.players && lineups.home.players.length > 0) {
        const playerId = lineups.home.players[0].player.id;
        console.log(`Testing Heatmap for Player ID: ${playerId}`);
        
        const heatmapUrl = `https://www.sofascore.com/api/v1/event/${matchId}/player/${playerId}/heatmap`;
        const res2 = await fetchWithRetry(heatmapUrl);
        if (res2) {
            const data2 = await res2.json();
            console.log("HEATMAP:", data2.heatmap ? `Found ${data2.heatmap.length} points` : data2);
        }
    }
}
test().catch(console.error);
