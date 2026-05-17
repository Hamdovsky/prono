const { SofaAPI, fetchWithRetry } = require('../SofascoreScraping/src/apiClient');

async function run() {
    const tournamentId = 1129; // Premier League 2
    console.log(`📡 Fetching seasons for tournament ${tournamentId}...`);
    try {
        const res = await fetchWithRetry(`https://www.sofascore.com/api/v1/unique-tournament/${tournamentId}/seasons`);
        const data = await res.json();
        const currentSeason = data.seasons[0];
        console.log(`Current Season: ${currentSeason.name} | ID: ${currentSeason.id}`);
        
        console.log(`📡 Fetching NEXT events for season ${currentSeason.id}...`);
        const nextRes = await fetchWithRetry(`https://www.sofascore.com/api/v1/unique-tournament/${tournamentId}/season/${currentSeason.id}/events/next/0`);
        const nextData = await nextRes.json();
        const events = nextData.events || [];
        console.log(`Found ${events.length} upcoming events.`);
        events.slice(0, 3).forEach(e => {
            console.log(`- ${e.homeTeam.name} vs ${e.awayTeam.name} at ${new Date(e.startTimestamp * 1000).toLocaleString()}`);
        });
    } catch (err) {
        console.error(err.message);
    }
}
run();
