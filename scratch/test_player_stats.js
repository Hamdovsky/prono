const { SofaAPI } = require('../SofascoreScraping/src/apiClient');

async function test() {
    const playerId = 24281; // De Bruyne
    const tournamentId = 17; // Premier League
    const seasonId = 52186; // Current season usually
    
    const stats = await SofaAPI.getPlayerStats(playerId, tournamentId, seasonId);
    console.log("Stats:", stats ? Object.keys(stats.statistics || stats) : "null");
    if (stats && stats.statistics) {
        console.log("xG:", stats.statistics.expectedGoals);
    }
}
test().catch(console.error);
